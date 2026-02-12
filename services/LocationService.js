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
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://658e-105-165-217-230.ngrok-free.app';

// ─── Background Task Definition ────────────────────────────────────────────────
// Must be defined at the TOP LEVEL (outside any component/class).
// Wrapped in try/catch: Expo Go on Android cannot register background tasks
// and will throw, crashing the app before any UI renders.
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
  console.warn('[LocationService] defineTask failed — background tracking unavailable (Expo Go limitation):', e.message);
}

// ─── LocationService Class ──────────────────────────────────────────────────────
class LocationService {
  constructor() {
    this.deviceId = null;
    this.driverId = null;
    this.isTracking = false;
    this.syncInterval = null;
  }

  /**
   * Call once on app launch with device/driver identifiers.
   */
  async init(deviceId, driverId) {
    this.deviceId = deviceId;
    this.driverId = driverId;
    // Start background sync loop every 30 seconds
    this.syncInterval = setInterval(() => this.flushQueue(), 30_000);
  }

  // ── Permission Requests ────────────────────────────────────────────────────

  async requestPermissions() {
    // 1. Foreground permission
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') {
      throw new Error('Foreground location permission denied. This app requires location access to track your vehicle.');
    }

    // 2. Background permission (Android shows a separate dialog)
    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    if (bg !== 'granted') {
      throw new Error(
        'Background location permission denied. ' +
        'Please go to Settings > Apps > FleetTracker > Permissions and enable "Allow all the time".'
      );
    }

    return true;
  }

  // ── Start / Stop Tracking ──────────────────────────────────────────────────

  async startTracking() {
    await this.requestPermissions();

    // Try to register background location task.
    // This WILL FAIL in Expo Go (not supported) — we fall back to foreground-only.
    try {
      const isAvailable = await TaskManager.isAvailableAsync();
      if (!isAvailable) {
        throw new Error('TaskManager not available (Expo Go limitation)');
      }

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
      // Expo Go or device restriction: fall back to foreground-only tracking
      console.warn('[LocationService] Background task failed, using foreground-only mode:', bgError.message);
      this.isTracking = true;
      this.usingBackgroundTask = false;
      // foreground watch is set up in App.tsx; it will call handleLocationUpdate directly
    }
  }

  async stopTracking() {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    this.isTracking = false;
    console.log('[LocationService] Tracking stopped.');
  }

  // ── Location Update Handler ────────────────────────────────────────────────

  /**
   * Called by the background task and optionally foreground updates.
   * Tries to POST immediately; if offline, queues locally.
   */
  static async handleLocationUpdate(location) {
    const instance = LocationService.instance;
    const payload = {
      deviceId: instance.deviceId,
      driverId: instance.driverId,
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,            // m/s
      heading: location.coords.heading,         // degrees
      altitude: location.coords.altitude,
      timestamp: new Date(location.timestamp).toISOString(),
    };

    const netState = await NetInfo.fetch();
    if (netState.isConnected) {
      const sent = await LocationService.postLocation(payload);
      if (!sent) await LocationService.enqueue(payload);
    } else {
      await LocationService.enqueue(payload);
    }
  }

  // ── HTTP POST ──────────────────────────────────────────────────────────────

  static async postLocation(payload) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
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
      // Cap queue at 2000 entries (~12h at 15s intervals) to avoid storage bloat
      if (queue.length > 2000) queue.splice(0, queue.length - 2000);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (err) {
      console.error('[LocationService] Enqueue error:', err.message);
    }
  }

  /**
   * Flush the offline queue in batches when connectivity is restored.
   */
  async flushQueue() {
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) return;

    try {
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (!raw) return;
      const queue = JSON.parse(raw);
      if (queue.length === 0) return;

      console.log(`[LocationService] Flushing ${queue.length} queued locations...`);

      // Send in chunks of 50
      const CHUNK_SIZE = 50;
      let sent = 0;
      for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
        const chunk = queue.slice(i, i + CHUNK_SIZE);
        const res = await fetch(`${API_BASE_URL}/api/locations/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locations: chunk }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) sent += chunk.length;
        else break; // Stop if server rejects; retry next interval
      }

      // Remove successfully sent items
      const remaining = queue.slice(sent);
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      console.log(`[LocationService] Flushed ${sent} locations. ${remaining.length} remaining.`);
    } catch (err) {
      console.error('[LocationService] Flush error:', err.message);
    }
  }
}

// Singleton
LocationService.instance = new LocationService();
export default LocationService.instance;