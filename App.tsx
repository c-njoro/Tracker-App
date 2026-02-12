/**
 * App.tsx — Fleet Tracker Mobile App
 * Entry point. Handles permission flow, shows tracking status,
 * and displays last known location.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  SafeAreaView,
  
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform,
  ActivityIndicator,
} from 'react-native';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import LocationService from './services/LocationService';

// ─── Constants ─────────────────────────────────────────────────────────────────
const DRIVER_ID_KEY = 'fleet_driver_id';

export default function App() {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'tracking' | 'error'>('idle');
  const [lastLocation, setLastLocation] = useState<Location.LocationObject | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const appState = useRef(AppState.currentState);

  // ── On Mount ──────────────────────────────────────────────────────────────

  useEffect(() => {
    bootstrapApp();

    // Watch app state changes (background → foreground) to refresh queue count
    const subscription = AppState.addEventListener('change', nextState => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        refreshQueueCount();
      }
      appState.current = nextState;
    });

    return () => subscription.remove();
  }, []);

  async function bootstrapApp() {
    // Get or generate a stable device ID
    let driverId = await AsyncStorage.getItem(DRIVER_ID_KEY);
    if (!driverId) {
      driverId = `driver_${Device.modelId ?? 'unknown'}_${Date.now()}`;
      await AsyncStorage.setItem(DRIVER_ID_KEY, driverId);
    }

    const deviceId = Device.osBuildId ?? Device.modelId ?? `device_${Date.now()}`;
    await LocationService.init(deviceId, driverId);

    // Auto-start if previously tracking (app was killed and restarted)
    await startTracking();
  }

  // ── Tracking Control ──────────────────────────────────────────────────────

  async function startTracking() {
    setStatus('requesting');
    setErrorMsg('');
    try {
      await LocationService.startTracking();

      // Get an immediate position for display
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLastLocation(pos);
      setStatus('tracking');

      // Always set up a foreground watch for live UI display.
      // When background task is unavailable (Expo Go), this also drives location
      // updates by calling LocationService.handleLocationUpdate directly.
      Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: 10 },
        async (loc) => {
          setLastLocation(loc);
          // In foreground-only mode, pipe updates through the service manually
          if (!LocationService.usingBackgroundTask) {
            await LocationService.constructor.handleLocationUpdate
              ? LocationService.constructor.handleLocationUpdate(loc)
              : LocationService.handleLocationUpdate?.(loc);
          }
        }
      );
    } catch (err: any) {
      setErrorMsg(err.message);
      setStatus('error');
      Alert.alert('Permission Required', err.message, [
        { text: 'Open Settings', onPress: () => Location.enableNetworkProviderAsync() },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  async function stopTracking() {
    await LocationService.stopTracking();
    setStatus('idle');
  }

  async function refreshQueueCount() {
    const raw = await AsyncStorage.getItem('fleet_offline_queue');
    const q = raw ? JSON.parse(raw) : [];
    setQueueCount(q.length);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isTracking = status === 'tracking';
  const coords = lastLocation?.coords;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <View style={[styles.dot, isTracking && styles.dotActive]} />
          <Text style={styles.appName}>FleetTracker</Text>
        </View>
        <Text style={styles.subtitle}>
          {isTracking ? 'Transmitting location' : 'Not tracking'}
        </Text>
      </View>

      {/* Status Card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>STATUS</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, isTracking ? styles.green : styles.grey]} />
          <Text style={[styles.statusText, isTracking ? styles.greenText : styles.greyText]}>
            {status === 'requesting' ? 'Requesting permissions...' :
             isTracking ? 'Active & Transmitting' :
             status === 'error' ? 'Permission Error' : 'Stopped'}
          </Text>
        </View>
        {status === 'requesting' && <ActivityIndicator style={{ marginTop: 8 }} color="#1A73E8" />}
      </View>

      {/* Location Card */}
      {coords && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LAST KNOWN POSITION</Text>
          <Text style={styles.coordText}>
            {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>
              Speed: {coords.speed != null ? `${(coords.speed * 3.6).toFixed(1)} km/h` : 'N/A'}
            </Text>
            <Text style={styles.meta}>
              Accuracy: ±{coords.accuracy?.toFixed(0)}m
            </Text>
          </View>
          {lastLocation?.timestamp && (
            <Text style={styles.timestamp}>
              Updated: {new Date(lastLocation.timestamp).toLocaleTimeString()}
            </Text>
          )}
        </View>
      )}

      {/* Offline Queue */}
      <TouchableOpacity style={styles.card} onPress={refreshQueueCount}>
        <Text style={styles.cardLabel}>OFFLINE QUEUE</Text>
        <Text style={styles.queueCount}>{queueCount}</Text>
        <Text style={styles.queueSub}>
          {queueCount === 0
            ? 'All locations synced ✓'
            : `${queueCount} location(s) waiting to sync (tap to refresh)`}
        </Text>
      </TouchableOpacity>

      {/* Error */}
      {errorMsg ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      ) : null}

      {/* Control Button */}
      <View style={styles.buttonRow}>
        {isTracking ? (
          <TouchableOpacity style={[styles.btn, styles.stopBtn]} onPress={stopTracking}>
            <Text style={styles.btnText}>Stop Tracking</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.btn, styles.startBtn, status === 'requesting' && styles.btnDisabled]}
            onPress={startTracking}
            disabled={status === 'requesting'}
          >
            <Text style={styles.btnText}>
              {status === 'requesting' ? 'Starting...' : 'Start Tracking'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.footer}>
        {LocationService.usingBackgroundTask
          ? Platform.OS === 'android'
            ? 'Running as Foreground Service on Android'
            : 'Running in Background on iOS'
          : '⚠ Foreground-only mode (build a dev build for background tracking)'}
      </Text>
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D1117', padding: 20 },

  header: { marginBottom: 28 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#444' },
  dotActive: { backgroundColor: '#00E676', shadowColor: '#00E676', shadowRadius: 8, shadowOpacity: 0.8 },
  appName: { fontSize: 24, fontWeight: '700', color: '#FFFFFF', letterSpacing: 1 },
  subtitle: { color: '#8B949E', marginTop: 4, fontSize: 13 },

  card: {
    backgroundColor: '#161B22',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#21262D',
  },
  cardLabel: { fontSize: 10, color: '#8B949E', letterSpacing: 2, marginBottom: 8 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  green: { backgroundColor: '#00E676' },
  grey: { backgroundColor: '#555' },
  statusText: { fontSize: 16, fontWeight: '600' },
  greenText: { color: '#00E676' },
  greyText: { color: '#8B949E' },

  coordText: { fontSize: 18, color: '#E6EDF3', fontWeight: '600', marginBottom: 8, fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', gap: 16 },
  meta: { color: '#8B949E', fontSize: 13 },
  timestamp: { color: '#444D56', fontSize: 12, marginTop: 4 },

  queueCount: { fontSize: 36, fontWeight: '700', color: '#E6EDF3' },
  queueSub: { color: '#8B949E', fontSize: 13, marginTop: 2 },

  errorBox: { backgroundColor: '#2D1B1B', borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#FF453A' },
  errorText: { color: '#FF453A', fontSize: 13 },

  buttonRow: { marginTop: 8 },
  btn: { padding: 16, borderRadius: 12, alignItems: 'center' },
  startBtn: { backgroundColor: '#1A73E8' },
  stopBtn: { backgroundColor: '#3A1A1A', borderWidth: 1, borderColor: '#FF453A' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  footer: { textAlign: 'center', color: '#30363D', fontSize: 11, marginTop: 16 },
});