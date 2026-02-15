/**
 * LocationService.js
 * Handles foreground + background GPS tracking with offline queue.
 * Uses expo-location for permissions and background tasks,
 * and AsyncStorage to persist unsent pings when offline.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

const BACKGROUND_LOCATION_TASK = 'background-location-task';
const OFFLINE_QUEUE_KEY = 'fleet_offline_queue';

// Reject any fix worse than this threshold.
// Filters out WiFi/cell tower guesses (typically 300–2000m) while
// accepting GPS fixes (typically 3–30m) and even assisted GPS (~50–150m).
const MAX_ACCEPTABLE_ACCURACY_METERS = 150;

let API_BASE_URL = 'https://3980-154-159-237-115.ngrok-free.app';

// ─── Background Task Definition ────────────────────────────────────────────────
try {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.error('[BG Task] Error:', error.message);
      return;
    }
    if (data) {
      const { locations } = data;
      for (const location of locations) {
        await LocationService.handleLocationUpdate(location);
      }
    }
  });
} catch (e) {
  console.warn('[LocationService] defineTask failed (Expo Go):', e.message);
}

// ─── Helper: fetch with manual timeout ────────────────────────────────────────
function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── LocationService Class ─────────────────────────────────────────────────────
class LocationService {
  constructor() {
    this.technicianId = null;
    this.userId = null;
    this.isTracking = false;
    this.usingBackgroundTask = false;
    this.syncInterval = null;
    this.foregroundCallback = null;
    this.foregroundSubscription = null;
  }

  async init(apiBase, technicianId, userId) {
    API_BASE_URL = apiBase;
    this.technicianId = technicianId;
    this.userId = userId;
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = setInterval(() => this.flushQueue(), 30_000);
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  async requestPermissions() {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') {
      throw new Error(
        'Foreground location permission denied. This app requires location access to track your vehicle.'
      );
    }
    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    if (bg !== 'granted') {
      throw new Error(
        'Background location permission denied. ' +
        'Go to Settings > Apps > FleetTracker > Permissions and enable "Allow all the time".'
      );
    }
    return true;
  }

  // ── Start / Stop ───────────────────────────────────────────────────────────

  async startTracking(onLocationUpdate = null) {
    this.foregroundCallback = onLocationUpdate;
    await this.requestPermissions();

    try {
      const isAvailable = await TaskManager.isAvailableAsync();
      if (!isAvailable) throw new Error('TaskManager not available (Expo Go)');

      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation, // ← upgraded from High
        timeInterval: 15_000,
        distanceInterval: 0,           // ← was 20m: 0 = time-based only, no distance gate.
                                       //   Prevents reusing a stale cached network fix
                                       //   when someone is stationary.
        deferredUpdatesInterval: 60_000,
        deferredUpdatesDistance: 50,   // ← tightened from 100m
        showsBackgroundLocationIndicator: true,
        mayShowUserSettingsDialog: true, // ← prompts to enable high-accuracy GPS mode on Android
        foregroundService: {
          notificationTitle: 'Fleet Tracker Active',
          notificationBody: 'Your location is being tracked.',
          notificationColor: '#1A73E8',
        },
        pausesUpdatesAutomatically: false,
      });

      this.isTracking = true;
      this.usingBackgroundTask = true;
      console.log('[LocationService] Background tracking started.');
    } catch (bgError) {
      console.warn('[LocationService] Background task failed, falling back to foreground-only mode:', bgError.message);

      this.foregroundSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation, // ← upgraded
          timeInterval: 15_000,
          distanceInterval: 0,          // ← same fix
        },
        (location) => {
          LocationService.handleLocationUpdate(location);
        }
      );

      this.isTracking = true;
      this.usingBackgroundTask = false;
    }
  }

  async stopTracking() {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      }
    } catch (e) {
      console.warn('[LocationService] stopTracking error:', e.message);
    }

    if (this.foregroundSubscription) {
      this.foregroundSubscription.remove();
      this.foregroundSubscription = null;
    }

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.isTracking = false;
    this.technicianId = null;  // ← FIX: was this.vehicleId (wrong field name from old code)
    this.userId = null;        // ← FIX: was this.driverId (wrong field name from old code)
    console.log('[LocationService] Tracking stopped.');
  }

  // ── Clear offline queue ────────────────────────────────────────────────────

  async clearQueue() {
    try {
      await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
      console.log('[LocationService] Offline queue cleared.');
    } catch (err) {
      console.error('[LocationService] clearQueue error:', err.message);
    }
  }

  // ── Location Update Handler ────────────────────────────────────────────────

  static async handleLocationUpdate(location) {
    const instance = LocationService.instance;

    if (!instance.technicianId || !instance.userId) {
      console.warn('[LocationService] Skipping location – technicianId/userId not set');
      return;
    }

    // ── Accuracy filter ──────────────────────────────────────────────────────
    // Drop coarse network/WiFi fixes before they reach the backend or queue.
    // Still fires the UI callback so the screen can show the live accuracy reading.
    const accuracy = location.coords.accuracy;
    if (accuracy !== null && accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
      console.warn(`[LocationService] Dropping low-accuracy fix: ±${accuracy.toFixed(0)}m`);
      if (instance.foregroundCallback) instance.foregroundCallback(location);
      return;
    }

    if (instance.foregroundCallback) {
      instance.foregroundCallback(location);
    }

    const payload = {
      technicianId: instance.technicianId,
      userId:       instance.userId,
      lat:          location.coords.latitude,
      lng:          location.coords.longitude,
      accuracy:     location.coords.accuracy,
      speed:        location.coords.speed,
      heading:      location.coords.heading,
      altitude:     location.coords.altitude,
      timestamp:    new Date(location.timestamp).toISOString(),
    };

    try {
      const netState = await NetInfo.fetch();
      if (netState.isConnected) {
        const sent = await LocationService.postLocation(payload);
        if (!sent) await LocationService.enqueue(payload);
      } else {
        await LocationService.enqueue(payload);
      }
    } catch (err) {
      console.warn('[LocationService] handleLocationUpdate error:', err.message);
      await LocationService.enqueue(payload);
    }
  }

  // ── HTTP POST ──────────────────────────────────────────────────────────────

  static async postLocation(payload) {
    try {
      const res = await fetchWithTimeout(
        `${API_BASE_URL}/api/locations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
          body: JSON.stringify(payload),
        },
        8000
      );
      return res.ok;
    } catch (err) {
      console.warn('[LocationService] POST failed:', err.message);
      return false;
    }
  }

  // ── Offline Queue ──────────────────────────────────────────────────────────

  static async enqueue(payload) {
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      const queue = raw ? JSON.parse(raw) : [];
      queue.push(payload);
      if (queue.length > 2000) queue.splice(0, queue.length - 2000);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (err) {
      console.error('[LocationService] Enqueue error:', err.message);
    }
  }

  async flushQueue() {
    try {
      const netState = await NetInfo.fetch();
      if (!netState.isConnected) return;

      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (!raw) return;
      const queue = JSON.parse(raw);
      if (queue.length === 0) return;

      // FIX: was checking this.vehicleId/this.driverId — stale field names after rename.
      // The guard never passed, so the queue never flushed.
      if (!this.technicianId || !this.userId) {
        console.warn('[LocationService] Skipping flush — no active shift');
        return;
      }

      console.log(`[LocationService] Flushing ${queue.length} queued pings...`);

      const CHUNK_SIZE = 50;
      let sent = 0;
      for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
        const chunk = queue.slice(i, i + CHUNK_SIZE);
        try {
          const res = await fetchWithTimeout(
            `${API_BASE_URL}/api/locations/batch`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
              body: JSON.stringify({ locations: chunk }),
            },
            15_000
          );
          if (res.ok) sent += chunk.length;
          else break;
        } catch {
          break;
        }
      }

      const remaining = queue.slice(sent);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      console.log(`[LocationService] Flushed ${sent}. Remaining: ${remaining.length}`);

      // FIX: typo 'lenght' → 'length'
      if (remaining.length === 0) {
        this.clearQueue();
      }
    } catch (err) {
      console.error('[LocationService] Flush error:', err.message);
    }
  }
}

// Singleton
LocationService.instance = new LocationService();
export default LocationService.instance;