/**
 * App.tsx — Fleet Tracker
 * Screen 1 (Setup): Driver picks their name from a list, picks a vehicle → Start Shift
 * Screen 2 (Tracking): Live GPS stats, End Shift button
 * Session survives app restarts via AsyncStorage.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Platform,
  SafeAreaView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LocationService from './services/LocationService';

// ─── Set this to your backend LAN IP ──────────────────────────────────────────
const API = 'https://29a2-105-165-217-230.ngrok-free.app';  // ← change to your server's IP
// ──────────────────────────────────────────────────────────────────────────────

const SESSION_KEY = 'fleet_active_session';

interface Driver  { _id: string; name: string; employeeId?: string; onShift: boolean; }
interface Vehicle {
  isActive: boolean; _id: string; name: string; plateNumber?: string; type: string; inUse: boolean; currentDriverName?: string; 
}

type Screen = 'loading' | 'setup' | 'tracking';
type Step   = 'driver' | 'vehicle';   // two-step setup wizard

export default function App() {
  const [screen, setScreen]                 = useState<Screen>('loading');
  const [step, setStep]                     = useState<Step>('driver');

  const [drivers, setDrivers]               = useState<Driver[]>([]);
  const [vehicles, setVehicles]             = useState<Vehicle[]>([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [loadingVehicles, setLoadingVehicles] = useState(false);

  const [selectedDriver, setSelectedDriver]   = useState<Driver | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [startingShift, setStartingShift]     = useState(false);

  const [lastLocation, setLastLocation]       = useState<Location.LocationObject | null>(null);
  const [activeSession, setActiveSession]     = useState<{
    driver: Driver; vehicle: Vehicle; startedAt: string;
  } | null>(null);

  // ── Boot ───────────────────────────────────────────────────────────────────
  useEffect(() => { boot(); }, []);

  async function boot() {
    try {
      const raw = await AsyncStorage.getItem(SESSION_KEY);
      if (raw) {
        const session = JSON.parse(raw);
        setActiveSession(session);
        await LocationService.init(API, session.vehicle._id, session.driver._id);
        await LocationService.startTracking(loc => setLastLocation(loc));
        setScreen('tracking');
      } else {
        setScreen('setup');
        fetchDrivers();
      }
    } catch {
      setScreen('setup');
      fetchDrivers();
    }
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  async function fetchDrivers() {
    setLoadingDrivers(true);
    try {
      const res = await fetch(`${API}/api/drivers`);
      if (!res.ok) throw new Error('Server error');
      setDrivers(await res.json());
    } catch (err: any) {
      Alert.alert('Cannot reach server', `Check the API address in App.tsx.\n\nAPI: ${API}\nError: ${err.message}`);
    } finally {
      setLoadingDrivers(false);
    }
  }

  async function fetchVehicles() {
    setLoadingVehicles(true);
    try {
      const res = await fetch(`${API}/api/vehicles`);
      if (!res.ok) throw new Error('Server error');
      const all: Vehicle[] = await res.json();
      setVehicles(all);
    } catch (err: any) {
      Alert.alert('Cannot reach server', err.message);
    } finally {
      setLoadingVehicles(false);
    }
  }

  // ── Start shift ────────────────────────────────────────────────────────────
  async function startShift() {
    if (!selectedDriver || !selectedVehicle) return;
    setStartingShift(true);
    console.log(selectedDriver, selectedVehicle)
    try {
      // Mark vehicle in-use on backend
      const res = await fetch(`${API}/api/vehicles/${selectedVehicle._id}/startShift`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startShift: true, driverId: selectedDriver._id }),
      });
      if (!res.ok) throw new Error(await res.text());

      await LocationService.init(API, selectedVehicle._id, selectedDriver._id);
      await LocationService.startTracking(loc => setLastLocation(loc));

      const session = {
        driver:     selectedDriver,
        vehicle:    selectedVehicle,
        startedAt:  new Date().toISOString(),
      };
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
      setActiveSession(session);
      setScreen('tracking');
    } catch (err: any) {
      Alert.alert('Failed to start shift', err.message);
    } finally {
      setStartingShift(false);
    }
  }

  // ── End shift ──────────────────────────────────────────────────────────────
  function confirmEndShift() {
    Alert.alert('End Shift', 'Are you sure you want to end your shift?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End Shift', style: 'destructive', onPress: doEndShift },
    ]);
  }

  
async function doEndShift() {
  Alert.alert(
    'End Shift',
    'Are you sure you want to end your shift?',
    [
      {
        text: 'Cancel',
        style: 'cancel',
      },
      {
        text: 'End Shift',
        style: 'destructive',
        onPress: async () => {
          try {
            await LocationService.stopTracking();

            if (activeSession) {
              await fetch(
                `${API}/api/vehicles/${activeSession.vehicle._id}/endShift`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    endShift: true,
                    driverId: activeSession.driver._id,
                  }),
                }
              );
            }

            await AsyncStorage.removeItem(SESSION_KEY);

            setActiveSession(null);
            setLastLocation(null);
            setSelectedDriver(null);
            setSelectedVehicle(null);
            setStep('driver');
            setScreen('setup');

            fetchDrivers();
            fetchVehicles();
          } catch (err) {
            console.error('Failed to end shift', err);
            Alert.alert(
              'Error',
              'Failed to end shift. Please try again.'
            );
          }
        },
      },
    ],
    { cancelable: true }
  );
}


  // ── Render ─────────────────────────────────────────────────────────────────
  if (screen === 'loading') {
    return (
      <SafeAreaView style={s.container}>
        <ActivityIndicator size="large" color={C.blue} />
        <Text style={s.loadingText}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (screen === 'tracking' && activeSession) {
    return (
      <TrackingScreen
        session={activeSession}
        lastLocation={lastLocation}
        onEndShift={doEndShift}
      />
    );
  }

  // ── Setup: Step 1 — Pick driver ───────────────────────────────────────────
  if (step === 'driver') {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <Text style={s.appName}>FleetTracker</Text>
          <Text style={s.subtitle}>Who are you?</Text>
        </View>

        <View style={s.stepIndicator}>
          <View style={[s.stepDot, s.stepDotActive]} /><View style={s.stepLine} />
          <View style={s.stepDot} />
        </View>

        <View style={s.sectionHeader}>
          <Text style={s.label}>SELECT YOUR NAME</Text>
          <TouchableOpacity onPress={fetchDrivers}>
            <Text style={s.refreshBtn}>↻ Refresh</Text>
          </TouchableOpacity>
        </View>

        {loadingDrivers
          ? <ActivityIndicator color={C.blue} style={{ marginTop: 20 }} />
          : drivers.length === 0
            ? <EmptyState
                message="No drivers found"
                sub="Ask your admin to add drivers on the dashboard."
                onRetry={fetchDrivers}
              />
            : (
              <FlatList
                data={drivers}
                keyExtractor={d => d._id}
                style={{ flex: 1, marginTop: 8 }}
                renderItem={({ item }) => {
                  const isSelected = selectedDriver?._id === item._id;
                  const isBusy = item.onShift;
                  return (
                    <TouchableOpacity
                      style={[s.listItem, isSelected && s.listItemSelected, isBusy && s.listItemDim]}
                      onPress={() => !isBusy && setSelectedDriver(item)}
                      disabled={isBusy}
                    >
                      <Text style={s.listItemIcon}>👤</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.listItemName, isSelected && s.listItemNameSelected]}>
                          {item.name}
                        </Text>
                        {item.employeeId && (
                          <Text style={s.listItemSub}>ID: {item.employeeId}</Text>
                        )}
                        {isBusy && <Text style={s.listItemBusy}>Currently on shift</Text>}
                      </View>
                      {isSelected && <Text style={s.check}>✓</Text>}
                    </TouchableOpacity>
                  );
                }}
              />
            )
        }

        <TouchableOpacity
          style={[s.primaryBtn, !selectedDriver && s.primaryBtnDisabled]}
          onPress={() => { fetchVehicles(); setStep('vehicle'); }}
          disabled={!selectedDriver}
        >
          <Text style={s.primaryBtnText}>Next — Select Vehicle</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Setup: Step 2 — Pick vehicle ──────────────────────────────────────────
  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => setStep('driver')} style={s.backBtn}>
          <Text style={s.backBtnText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.appName}>FleetTracker</Text>
        <Text style={s.subtitle}>
          Hi, <Text style={{ color: C.blue }}>{selectedDriver?.name}</Text>. Pick your vehicle.
        </Text>
      </View>

      <View style={s.stepIndicator}>
        <View style={[s.stepDot, s.stepDotDone]} /><View style={[s.stepLine, s.stepLineDone]} />
        <View style={[s.stepDot, s.stepDotActive]} />
      </View>

      <View style={s.sectionHeader}>
        <Text style={s.label}>SELECT VEHICLE</Text>
        <TouchableOpacity onPress={fetchVehicles}>
          <Text style={s.refreshBtn}>↻ Refresh</Text>
        </TouchableOpacity>
      </View>

      {loadingVehicles
        ? <ActivityIndicator color={C.blue} style={{ marginTop: 20 }} />
        : vehicles.length === 0
          ? <EmptyState
              message="No vehicles found"
              sub="Ask your admin to add vehicles on the dashboard."
              onRetry={fetchVehicles}
            />
          : (
            <FlatList
              data={vehicles}
              keyExtractor={v => v._id}
              style={{ flex: 1, marginTop: 8 }}
              renderItem={({ item }) => {
                const isSelected = selectedVehicle?._id === item._id;
                const isTaken = item.isActive;
                return (
                  <TouchableOpacity
                    style={[s.listItem, isSelected && s.listItemSelected, isTaken && s.listItemDim]}
                    onPress={() => !isTaken && setSelectedVehicle(item)}
                    disabled={isTaken}
                  >
                    <Text style={s.listItemIcon}>
                      {item.type === 'truck' ? '🚛' : item.type === 'van' ? '🚐' :
                       item.type === 'motorcycle' ? '🏍' : '🚗'}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.listItemName, isSelected && s.listItemNameSelected]}>
                        {item.name}
                      </Text>
                      {item.plateNumber && (
                        <Text style={s.listItemSub}>{item.plateNumber}</Text>
                      )}
                      {isTaken && (
                        <Text style={s.listItemBusy}>In use · {item.currentDriverName}</Text>
                      )}
                    </View>
                    {isSelected && <Text style={s.check}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          )
      }

      <TouchableOpacity
        style={[s.primaryBtn, (!selectedVehicle || startingShift) && s.primaryBtnDisabled]}
        onPress={startShift}
        disabled={!selectedVehicle || startingShift}
      >
        {startingShift
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.primaryBtnText}>Start Shift</Text>
        }
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// ─── Tracking Screen ───────────────────────────────────────────────────────────
function TrackingScreen({ session, lastLocation, onEndShift }: {
  session: { driver: Driver; vehicle: Vehicle; startedAt: string };
  lastLocation: Location.LocationObject | null;
  onEndShift: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const coords    = lastLocation?.coords;
  const speedKmh  = coords?.speed != null && coords.speed >= 0
    ? (coords.speed * 3.6).toFixed(1) : '0.0';
  const mins      = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60_000);
  const duration  = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <View style={s.liveBadge}>
          <View style={s.liveDot} />
          <Text style={s.liveText}>LIVE</Text>
        </View>
        <Text style={s.appName}>Shift Active</Text>
      </View>

      {/* Who + What */}
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

      {/* Live stats */}
      <View style={s.statsRow}>
        {[
          { value: speedKmh, unit: 'km/h' },
          { value: coords?.heading != null ? `${coords.heading.toFixed(0)}°` : '–', unit: 'heading' },
          { value: coords?.accuracy != null ? `±${coords.accuracy.toFixed(0)}m` : '–', unit: 'accuracy' },
        ].map((stat, i) => (
          <View key={i} style={s.statCell}>
            <Text style={s.statValue}>{stat.value}</Text>
            <Text style={s.statUnit}>{stat.unit}</Text>
          </View>
        ))}
      </View>

      {/* Coordinates */}
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

      <TouchableOpacity style={s.endBtn} onPress={onEndShift}>
        <Text style={s.endBtnText}>End Shift</Text>
      </TouchableOpacity>
      <Text style={s.footer}>
        {Platform.OS === 'android' ? 'Running as Foreground Service' : 'Background location active'}
      </Text>
    </SafeAreaView>
  );
}

// ─── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ message, sub, onRetry }: { message: string; sub: string; onRetry: () => void }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{message}</Text>
      <Text style={s.emptySub}>{sub}</Text>
      <TouchableOpacity style={s.retryBtn} onPress={onRetry}>
        <Text style={s.retryText}>Try Again</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const C = { bg:'#0D1117', surface:'#161B22', border:'#21262D',
            text:'#E6EDF3', muted:'#8B949E', dim:'#444D56',
            blue:'#1A73E8', green:'#00E676', red:'#FF453A' };

const s = StyleSheet.create({
  container:    { flex:1, backgroundColor:C.bg, padding:20 },
  loadingText:  { color:C.muted, marginTop:12, textAlign:'center' },

  header:    { marginBottom:16 },
  appName:   { fontSize:24, fontWeight:'700', color:C.text },
  subtitle:  { color:C.muted, marginTop:4, fontSize:14 },
  backBtn:   { marginBottom:4 },
  backBtnText: { color:C.blue, fontSize:14 },

  stepIndicator: { flexDirection:'row', alignItems:'center', marginBottom:20 },
  stepDot:       { width:10, height:10, borderRadius:5, backgroundColor:C.border },
  stepDotActive: { backgroundColor:C.blue },
  stepDotDone:   { backgroundColor:C.green },
  stepLine:      { flex:1, height:1, backgroundColor:C.border, marginHorizontal:6 },
  stepLineDone:  { backgroundColor:C.green },

  sectionHeader: { flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:8 },
  label:         { fontSize:10, letterSpacing:2, color:C.muted, textTransform:'uppercase' },
  refreshBtn:    { color:C.blue, fontSize:13 },

  listItem:         { flexDirection:'row', alignItems:'center', gap:12, backgroundColor:C.surface,
                      borderWidth:1, borderColor:C.border, borderRadius:10, padding:14, marginBottom:8 },
  listItemSelected: { borderColor:C.blue, backgroundColor:'#0D2137' },
  listItemDim:      { opacity:0.4 },
  listItemIcon:     { fontSize:24 },
  listItemName:     { fontSize:15, fontWeight:'600', color:C.text },
  listItemNameSelected: { color:C.blue },
  listItemSub:      { fontSize:11, color:C.muted, letterSpacing:1, marginTop:2 },
  listItemBusy:     { fontSize:11, color:C.red, marginTop:2 },
  check:            { fontSize:18, color:C.blue, fontWeight:'700' },

  primaryBtn:         { backgroundColor:C.blue, padding:16, borderRadius:12, alignItems:'center', marginTop:8 },
  primaryBtnDisabled: { opacity:0.4 },
  primaryBtnText:     { color:'#fff', fontWeight:'700', fontSize:16 },

  // Tracking
  liveBadge: { flexDirection:'row', alignItems:'center', gap:6, marginBottom:4 },
  liveDot:   { width:8, height:8, borderRadius:4, backgroundColor:C.green },
  liveText:  { fontSize:11, fontWeight:'700', color:C.green, letterSpacing:2 },

  card:           { backgroundColor:C.surface, borderRadius:12, padding:16,
                    borderWidth:1, borderColor:C.border, marginBottom:12 },
  cardDriver:     { fontSize:22, fontWeight:'700', color:C.text },
  cardEmployeeId: { fontSize:11, color:C.muted, marginTop:2 },
  divider:        { height:1, backgroundColor:C.border, marginVertical:10 },
  cardVehicle:    { fontSize:15, fontWeight:'600', color:C.muted },
  cardPlate:      { alignSelf:'flex-start', marginTop:4, fontSize:11, letterSpacing:2, color:C.muted,
                    backgroundColor:'#21262D', paddingHorizontal:8, paddingVertical:2, borderRadius:4 },
  cardDuration:   { fontSize:12, color:C.dim, marginTop:8 },

  statsRow:  { flexDirection:'row', gap:8, marginBottom:12 },
  statCell:  { flex:1, backgroundColor:C.surface, borderRadius:10, borderWidth:1,
               borderColor:C.border, padding:14, alignItems:'center' },
  statValue: { fontSize:20, fontWeight:'700', color:'#38BDF8', fontVariant:['tabular-nums'] },
  statUnit:  { fontSize:10, color:C.muted, marginTop:4, letterSpacing:1 },

  coordsLabel: { fontSize:9, letterSpacing:2, color:C.dim, marginBottom:6, textTransform:'uppercase' },
  coordsText:  { fontSize:15, color:C.text, fontVariant:['tabular-nums'] },
  coordsTime:  { fontSize:11, color:C.dim, marginTop:4 },

  endBtn:     { padding:16, borderRadius:12, alignItems:'center',
                backgroundColor:'#1A0A0A', borderWidth:1, borderColor:C.red },
  endBtnText: { color:C.red, fontWeight:'700', fontSize:16 },
  footer:     { textAlign:'center', color:C.dim, fontSize:11, marginTop:12 },

  empty:      { flex:1, alignItems:'center', justifyContent:'center', paddingTop:40 },
  emptyTitle: { color:C.text, fontSize:16, fontWeight:'600' },
  emptySub:   { color:C.muted, fontSize:13, textAlign:'center', marginTop:8, paddingHorizontal:20 },
  retryBtn:   { marginTop:16, padding:10, borderRadius:8, borderWidth:1, borderColor:C.border },
  retryText:  { color:C.blue, fontSize:13 },
});