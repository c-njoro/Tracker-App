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
let API_BASE_URL = 'https://6685-105-165-217-230.ngrok-free.app'; // set dynamically via init()

// ─── Background Task Definition ────────────────────────────────────────────────
// Must be at TOP LEVEL. Wrapped in try/catch — Expo Go can't register bg tasks.
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

// ─── Helper: fetch with manual timeout (Hermes doesn't support AbortSignal.timeout) ──
function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── LocationService Class ─────────────────────────────────────────────────────
class LocationService {
  constructor() {
    this.vehicleId = null;
    this.driverId = null;
    this.isTracking = false;
    this.usingBackgroundTask = false;
    this.syncInterval = null;
    this.foregroundCallback = null;
    this.foregroundSubscription = null; // <-- NEW: hold foreground watcher
  }

  async init(apiBase, vehicleId, driverId) {
    API_BASE_URL = apiBase;
    this.vehicleId = vehicleId;
    this.driverId = driverId;
    if (this.syncInterval) clearInterval(this.syncInterval);
    // Flush offline queue every 30 seconds
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
        accuracy: Location.Accuracy.High,
        timeInterval: 15_000,
        distanceInterval: 20,
        deferredUpdatesInterval: 60_000,
        deferredUpdatesDistance: 100,
        showsBackgroundLocationIndicator: true,
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
      // --- FALLBACK: Foreground-only mode ---
      console.warn('[LocationService] Background task failed, falling back to foreground-only mode:', bgError.message);
      
      // Start a foreground watcher that calls the same handler
      this.foregroundSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 15_000,
          distanceInterval: 20,
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

    // Remove foreground subscription if active
    if (this.foregroundSubscription) {
      this.foregroundSubscription.remove();
      this.foregroundSubscription = null;
    }

    if (this.syncInterval) clearInterval(this.syncInterval);
    this.isTracking = false;
    console.log('[LocationService] Tracking stopped.');
  }

  // ── Location Update Handler ────────────────────────────────────────────────

  static async handleLocationUpdate(location) {
    const instance = LocationService.instance;

    // --- GUARD: Don't send if vehicle/driver not set ---
    if (!instance.vehicleId || !instance.driverId) {
      console.warn('[LocationService] Skipping location – vehicleId/driverId not set');
      return;
    }

    // Fire UI callback first so the screen updates immediately
    if (instance.foregroundCallback) {
      instance.foregroundCallback(location);
    }

    const payload = {
      vehicleId: instance.vehicleId,
      driverId:  instance.driverId,
      lat:       location.coords.latitude,
      lng:       location.coords.longitude,
      accuracy:  location.coords.accuracy,
      speed:     location.coords.speed,
      heading:   location.coords.heading,
      altitude:  location.coords.altitude,
      timestamp: new Date(location.timestamp).toISOString(),
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
          headers: { 'Content-Type': 'application/json', "ngrok-skip-browser-warning": "true"  },
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
      // Cap at 2000 entries (~8h at 15s intervals)
      if (queue.length > 2000) queue.splice(0, queue.length - 2000);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (err) {
      console.error('[LocationService] Enqueue error:', err.message);
    }
  }

  async flushQueue() {
    // NOTE: no location/foregroundCallback call here — this is a background sync
    try {
      const netState = await NetInfo.fetch();
      if (!netState.isConnected) return;

      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (!raw) return;
      const queue = JSON.parse(raw);
      if (queue.length === 0) return;

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
              headers: { 'Content-Type': 'application/json', "ngrok-skip-browser-warning": "true"  },
              body: JSON.stringify({ locations: chunk }),
            },
            15_000
          );
          if (res.ok) sent += chunk.length;
          else break;
        } catch {
          break; // Network issue — retry next interval
        }
      }

      const remaining = queue.slice(sent);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      console.log(`[LocationService] Flushed ${sent}. Remaining: ${remaining.length}`);
    } catch (err) {
      console.error('[LocationService] Flush error:', err.message);
    }
  }
}

// Singleton
LocationService.instance = new LocationService();
export default LocationService.instance;