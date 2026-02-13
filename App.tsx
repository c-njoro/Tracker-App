/**
 * App.tsx — Fleet Tracker
 *
 * Screens:
 *  'loading'   → Boot: check for active shift or existing registration
 *  'register'  → First launch only: employee enters name, phone, badge ID
 *  'waiting'   → Registered, polling every 30s for a shift assigned by admin
 *  'tracking'  → Shift active — live GPS stats + End Shift button
 *
 * Flow:
 *  1. Employee registers once on the app (name, phone, employee ID)
 *  2. App shows waiting screen and polls GET /api/drivers/:id/shift-status every 30s
 *  3. When admin assigns a vehicle + starts shift on dashboard, poll detects it
 *  4. LocationService starts automatically, app moves to tracking screen
 *  5. Tracking screen also polls every 30s — when admin ends shift, app returns to waiting
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform,
  StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; // ✅ Updated import
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LocationService from './services/LocationService';

// ─── Config ────────────────────────────────────────────────────────────────────
const API              = 'https://6685-105-165-217-230.ngrok-free.app';
const POLL_INTERVAL_MS = 30_000;
const SESSION_KEY      = 'fleet_active_session';
const REGISTRATION_KEY = 'fleet_driver_registration';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Driver {
  _id: string;
  name: string;
  employeeId?: string;
  phone?: string;
  onShift: boolean;
}

interface Vehicle {
  _id: string;
  name: string;
  plateNumber?: string;
  type: string;
  isActive: boolean;
  inUse: boolean;
  currentDriverName?: string;
}

interface ActiveSession {
  driver: Driver;
  vehicle: Vehicle;
  startedAt: string;
}

type Screen = 'loading' | 'register' | 'waiting' | 'tracking';

// ─── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]                     = useState<Screen>('loading');
  const [registeredDriver, setRegisteredDriver] = useState<Driver | null>(null);
  const [activeSession, setActiveSession]       = useState<ActiveSession | null>(null);
  const [lastLocation, setLastLocation]         = useState<Location.LocationObject | null>(null);

  // Registration form
  const [regName, setRegName]         = useState('');
  const [regPhone, setRegPhone]       = useState('');
  const [regEmpId, setRegEmpId]       = useState('');
  const [registering, setRegistering] = useState(false);

  // Polling feedback shown on waiting screen
  const [lastPollTime, setLastPollTime] = useState<Date | null>(null);
  const [pollError, setPollError]       = useState(false);

  // Use a ref for the interval so it doesn't need to be in dependency arrays
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Boot ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    boot();
    return () => stopPolling();
  }, []);

  async function boot() {
    try {
      // 1. Resume an in-progress shift if the app was killed mid-shift
      const sessionRaw = await AsyncStorage.getItem(SESSION_KEY);
      if (sessionRaw) {
        const session: ActiveSession = JSON.parse(sessionRaw);
        setActiveSession(session);
        await LocationService.init(API, session.vehicle._id, session.driver._id);
        await LocationService.startTracking((loc) => setLastLocation(loc));
        setScreen('tracking');
        return;
      }

      // 2. Already registered — go straight to waiting screen
      const regRaw = await AsyncStorage.getItem(REGISTRATION_KEY);
      if (regRaw) {
        const driver: Driver = JSON.parse(regRaw);
        setRegisteredDriver(driver);
        setScreen('waiting');
        return;
      }

      // 3. First launch — show registration form
      setScreen('register');
    } catch {
      setScreen('register');
    }
  }

  // ── Poll helpers ──────────────────────────────────────────────────────────────
  function stopPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  // Passed a driver so it doesn't depend on state that may be stale inside setInterval
  const runPoll = useCallback(async (driver: Driver, isTrackingPoll = false) => {
    try {
      const res = await fetch(
        `${API}/api/drivers/${driver._id}/shift-status`,
        { headers: { 'ngrok-skip-browser-warning': 'true' } }
      );

      if (!isTrackingPoll) {
        setLastPollTime(new Date());
        setPollError(!res.ok);
      }

      if (!res.ok) return;

      const data: {
        onShift: boolean;
        vehicle: Vehicle | null;
        shiftStartedAt: string | null;
      } = await res.json();

      if (isTrackingPoll) {
        // During active tracking: detect when admin ends the shift
        if (!data.onShift) {
          await doStopTracking(driver);
        }
        return;
      }

      // During waiting: detect when admin starts a shift
      if (!data.onShift || !data.vehicle) return;

      const session: ActiveSession = {
        driver,
        vehicle:   data.vehicle,
        startedAt: data.shiftStartedAt ?? new Date().toISOString(),
      };

      stopPolling();
      await LocationService.init(API, data.vehicle._id, driver._id);
      await LocationService.startTracking((loc) => setLastLocation(loc));
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
      setActiveSession(session);
      setScreen('tracking');
    } catch {
      if (!isTrackingPoll) setPollError(true);
    }
  }, []);

  // ── Start waiting poll when screen = 'waiting' ────────────────────────────────
  useEffect(() => {
    if (screen !== 'waiting' || !registeredDriver) {
      stopPolling();
      return;
    }

    const driver = registeredDriver;
    runPoll(driver);                                         // immediate first check
    pollIntervalRef.current = setInterval(
      () => runPoll(driver),
      POLL_INTERVAL_MS
    );

    return () => stopPolling();
  }, [screen, registeredDriver, runPoll]);

  // ── Start tracking poll when screen = 'tracking' ──────────────────────────────
  // Detects when admin ends the shift from the dashboard
  useEffect(() => {
    if (screen !== 'tracking' || !activeSession) return;

    const driver = activeSession.driver;
    const interval = setInterval(
      () => runPoll(driver, true),
      POLL_INTERVAL_MS
    );

    return () => clearInterval(interval);
  }, [screen, activeSession, runPoll]);

  // ── Stop tracking & return to waiting ─────────────────────────────────────────
  async function doStopTracking(driver: Driver) {
    await LocationService.stopTracking();
    await AsyncStorage.removeItem(SESSION_KEY);
    setActiveSession(null);
    setLastLocation(null);
    setRegisteredDriver(driver);
    setScreen('waiting');
  }

  // ── Manual end shift (End Shift button on phone) ──────────────────────────────
  // Note: in the new flow the admin ends shifts, but keep this as a fallback
  function confirmEndShift() {
    Alert.alert('End Shift', 'Are you sure you want to end your shift?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Shift', style: 'destructive',
        onPress: async () => {
          if (!activeSession) return;
          try {
            await fetch(`${API}/api/vehicles/${activeSession.vehicle._id}/endShift`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true',
              },
              body: JSON.stringify({ endShift: true, driverId: activeSession.driver._id }),
            }).catch(() => {});
            await doStopTracking(activeSession.driver);
          } catch (err) {
            Alert.alert('Error', 'Failed to end shift. Please try again.');
          }
        },
      },
    ]);
  }

  // ── Registration ──────────────────────────────────────────────────────────────
  async function handleRegister() {
    if (!regName.trim()) {
      Alert.alert('Name required', 'Please enter your full name.');
      return;
    }
    setRegistering(true);
    try {
      const deviceId = Device.osBuildId ?? Device.modelId ?? `device_${Date.now()}`;

      const res = await fetch(`${API}/api/drivers/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({
          name:       regName.trim(),
          phone:      regPhone.trim() || undefined,
          employeeId: regEmpId.trim() || undefined,
          deviceId,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Registration failed');
      }

      const driver: Driver = await res.json();
      await AsyncStorage.setItem(REGISTRATION_KEY, JSON.stringify(driver));
      setRegisteredDriver(driver);
      setScreen('waiting');
    } catch (err: any) {
      Alert.alert('Registration failed', err.message);
    } finally {
      setRegistering(false);
    }
  }

  // ── Unregister ────────────────────────────────────────────────────────────────
  function confirmUnregister() {
    Alert.alert(
      'Remove Account',
      'This will remove your account from this device. You will need to register again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            stopPolling();
            await AsyncStorage.removeItem(REGISTRATION_KEY);
            setRegisteredDriver(null);
            setRegName('');
            setRegPhone('');
            setRegEmpId('');
            setScreen('register');
          },
        },
      ]
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (screen === 'loading') {
    return (
      <SafeAreaView style={s.container}>
        <ActivityIndicator size="large" color={C.blue} />
        <Text style={s.loadingText}>Loading…</Text>
      </SafeAreaView>
    );
  }

  // ── Register Screen ───────────────────────────────────────────────────────────
  if (screen === 'register') {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <Text style={s.appName}>FleetTracker</Text>
          <Text style={s.subtitle}>Create your account to get started</Text>
        </View>

        <View style={s.card}>
          <Text style={s.fieldLabel}>FULL NAME *</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. John Kamau"
            placeholderTextColor={C.dim}
            value={regName}
            onChangeText={setRegName}
            autoCapitalize="words"
            returnKeyType="next"
          />

          <Text style={[s.fieldLabel, { marginTop: 16 }]}>PHONE NUMBER</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. 0712 345 678"
            placeholderTextColor={C.dim}
            value={regPhone}
            onChangeText={setRegPhone}
            keyboardType="phone-pad"
            returnKeyType="next"
          />

          <Text style={[s.fieldLabel, { marginTop: 16 }]}>EMPLOYEE / BADGE ID</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. EMP-001 (optional)"
            placeholderTextColor={C.dim}
            value={regEmpId}
            onChangeText={setRegEmpId}
            autoCapitalize="characters"
            returnKeyType="done"
          />
        </View>

        <Text style={s.permissionNote}>
          After registering, you'll be asked to allow location access.
          This is required for tracking during your shift.
        </Text>

        <TouchableOpacity
          style={[s.primaryBtn, (!regName.trim() || registering) && s.primaryBtnDisabled]}
          onPress={handleRegister}
          disabled={!regName.trim() || registering}
        >
          {registering
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.primaryBtnText}>Register</Text>
          }
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Waiting Screen ────────────────────────────────────────────────────────────
  if (screen === 'waiting') {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <Text style={s.appName}>FleetTracker</Text>
        </View>

        <View style={s.waitingCard}>
          <Text style={s.waitingIcon}>👋</Text>
          <Text style={s.waitingName}>Hi, {registeredDriver?.name}</Text>
          {registeredDriver?.employeeId && (
            <Text style={s.waitingMeta}>ID: {registeredDriver.employeeId}</Text>
          )}
          {registeredDriver?.phone && (
            <Text style={s.waitingMeta}>{registeredDriver.phone}</Text>
          )}

          <View style={s.waitingDivider} />

          <View style={s.waitingStatusRow}>
            <View style={[s.waitingDot, pollError && s.waitingDotError]} />
            <Text style={[s.waitingStatus, pollError && s.waitingStatusError]}>
              {pollError ? 'Cannot reach server' : 'Waiting for shift assignment'}
            </Text>
          </View>

          <Text style={s.waitingSub}>
            Your manager will assign you a vehicle and start your shift
            from the dashboard. This app will begin tracking automatically.
          </Text>

          <Text style={s.waitingPollNote}>
            {pollError
              ? '⚠ Check your internet connection — retrying every 30s'
              : lastPollTime
                ? `↻ Last checked: ${lastPollTime.toLocaleTimeString()} · every 30s`
                : '↻ Checking now…'
            }
          </Text>
        </View>

        <TouchableOpacity style={s.unregisterBtn} onPress={confirmUnregister}>
          <Text style={s.unregisterText}>Not you? Remove account from this device</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Tracking Screen ───────────────────────────────────────────────────────────
  if (screen === 'tracking' && activeSession) {
    return (
      <TrackingScreen
        session={activeSession}
        lastLocation={lastLocation}
        onEndShift={confirmEndShift}
      />
    );
  }

  return null;
}

// ─── Tracking Screen Component ────────────────────────────────────────────────
function TrackingScreen({ session, lastLocation, onEndShift }: {
  session: ActiveSession;
  lastLocation: Location.LocationObject | null;
  onEndShift: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const coords   = lastLocation?.coords;
  const speedKmh = coords?.speed != null && coords.speed >= 0
    ? (coords.speed * 3.6).toFixed(1) : '0.0';
  const mins     = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60_000);
  const duration = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <View style={s.liveBadge}>
          <View style={s.liveDot} />
          <Text style={s.liveText}>LIVE</Text>
        </View>
        <Text style={s.appName}>Shift Active</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardDriver}>{session.driver.name}</Text>
        {session.driver.employeeId && (
          <Text style={s.cardEmployeeId}>ID: {session.driver.employeeId}</Text>
        )}
        <View style={s.divider} />
        <Text style={s.cardVehicle}>{session.vehicle.name}</Text>
        {session.vehicle.plateNumber && (
          <Text style={s.cardPlate}>{session.vehicle.plateNumber}</Text>
        )}
        <Text style={s.cardDuration}>Duration: {duration}</Text>
      </View>

      <View style={s.statsRow}>
        {[
          { value: speedKmh, unit: 'km/h' },
          { value: coords?.heading  != null ? `${coords.heading.toFixed(0)}°`   : '–', unit: 'heading'  },
          { value: coords?.accuracy != null ? `±${coords.accuracy.toFixed(0)}m` : '–', unit: 'accuracy' },
        ].map((stat, i) => (
          <View key={i} style={s.statCell}>
            <Text style={s.statValue}>{stat.value}</Text>
            <Text style={s.statUnit}>{stat.unit}</Text>
          </View>
        ))}
      </View>

      <View style={s.card}>
        {coords ? (
          <>
            <Text style={s.coordsLabel}>CURRENT POSITION</Text>
            <Text style={s.coordsText}>
              {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)}
            </Text>
            {lastLocation?.timestamp && (
              <Text style={s.coordsTime}>
                Updated: {new Date(lastLocation.timestamp).toLocaleTimeString()}
              </Text>
            )}
          </>
        ) : (
          <>
            <ActivityIndicator color={C.blue} />
            <Text style={[s.coordsLabel, { marginTop: 8 }]}>Acquiring GPS signal…</Text>
          </>
        )}
      </View>

      <View style={{ flex: 1 }} />
      <Text style={s.footer}>
        {Platform.OS === 'android' ? 'Running as Foreground Service' : 'Background location active'}
      </Text>
    </SafeAreaView>
  );
}

// ─── Colours & Styles ─────────────────────────────────────────────────────────
const C = {
  bg: '#0D1117', surface: '#161B22', border: '#21262D',
  text: '#E6EDF3', muted: '#8B949E', dim: '#444D56',
  blue: '#1A73E8', green: '#00E676', red: '#FF453A',
};

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: C.bg, padding: 20 },
  loadingText: { color: C.muted, marginTop: 12, textAlign: 'center' },
  header:      { marginBottom: 20 },
  appName:     { fontSize: 24, fontWeight: '700', color: C.text },
  subtitle:    { color: C.muted, marginTop: 4, fontSize: 14 },

  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: C.border, marginBottom: 12,
  },

  // Register
  fieldLabel: { fontSize: 10, letterSpacing: 2, color: C.muted, marginBottom: 6, textTransform: 'uppercase' },
  input: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 12, color: C.text, fontSize: 15, marginBottom: 2,
  },
  permissionNote: {
    color: C.dim, fontSize: 12, textAlign: 'center',
    marginVertical: 14, paddingHorizontal: 8, lineHeight: 18,
  },
  primaryBtn:         { backgroundColor: C.blue, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },

  // Waiting
  waitingCard: {
    backgroundColor: C.surface, borderRadius: 16, padding: 24,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', marginTop: 4,
  },
  waitingIcon:        { fontSize: 40, marginBottom: 12 },
  waitingName:        { fontSize: 22, fontWeight: '700', color: C.text },
  waitingMeta:        { fontSize: 12, color: C.muted, marginTop: 4, letterSpacing: 1 },
  waitingDivider:     { width: '100%', height: 1, backgroundColor: C.border, marginVertical: 16 },
  waitingStatusRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  waitingDot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  waitingDotError:    { backgroundColor: C.red },
  waitingStatus:      { fontSize: 13, fontWeight: '600', color: C.green },
  waitingStatusError: { color: C.red },
  waitingSub:         { fontSize: 13, color: C.muted, textAlign: 'center', lineHeight: 20 },
  waitingPollNote:    { fontSize: 11, color: C.dim, marginTop: 12 },
  unregisterBtn:      { marginTop: 28, alignItems: 'center', padding: 12 },
  unregisterText:     { color: C.dim, fontSize: 12 },

  // Tracking
  liveBadge:      { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  liveDot:        { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  liveText:       { fontSize: 11, fontWeight: '700', color: C.green, letterSpacing: 2 },
  cardDriver:     { fontSize: 22, fontWeight: '700', color: C.text },
  cardEmployeeId: { fontSize: 11, color: C.muted, marginTop: 2 },
  divider:        { height: 1, backgroundColor: C.border, marginVertical: 10 },
  cardVehicle:    { fontSize: 15, fontWeight: '600', color: C.muted },
  cardPlate: {
    alignSelf: 'flex-start', marginTop: 4, fontSize: 11, letterSpacing: 2, color: C.muted,
    backgroundColor: '#21262D', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4,
  },
  cardDuration: { fontSize: 12, color: C.dim, marginTop: 8 },
  statsRow:     { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statCell: {
    flex: 1, backgroundColor: C.surface, borderRadius: 10,
    borderWidth: 1, borderColor: C.border, padding: 14, alignItems: 'center',
  },
  statValue:   { fontSize: 20, fontWeight: '700', color: '#38BDF8', fontVariant: ['tabular-nums'] },
  statUnit:    { fontSize: 10, color: C.muted, marginTop: 4, letterSpacing: 1 },
  coordsLabel: { fontSize: 9, letterSpacing: 2, color: C.dim, marginBottom: 6, textTransform: 'uppercase' },
  coordsText:  { fontSize: 15, color: C.text, fontVariant: ['tabular-nums'] },
  coordsTime:  { fontSize: 11, color: C.dim, marginTop: 4 },
  endBtn: {
    padding: 16, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#1A0A0A', borderWidth: 1, borderColor: C.red,
  },
  endBtnText: { color: C.red, fontWeight: '700', fontSize: 16 },
  footer:     { textAlign: 'center', color: C.dim, fontSize: 11, marginTop: 12 },
});