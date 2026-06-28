import type { Server } from 'socket.io';
import type { Pool } from 'pg';
import type { VehiclePosition, LivePosition, UpcomingStop } from '@takemethere/shared';
import { projectToLine } from '@takemethere/shared';
import type { StopCoord } from '@takemethere/shared';
import type { TripUpdateEntry } from './decoder.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';
import { updateLivePosition } from './streamer.js';
import { findSegmentStops, findSegmentFromTU, computeSegmentPrediction } from './segment.js';

// StopCoord extended with stop name for admin inspector lookups
export interface StopData extends StopCoord {
  stopName: string;
}

// ─── Module-level state ───────────────────────────────────────────────────────

let dbPool: Pool | null = null;
let routeLineMap: Map<string, string> = new Map();
let tripDirections: Map<string, number> = new Map();
let lineStops: Map<string, StopData[]> = new Map();
let stopCxByLine: Map<string, Map<string, number>> = new Map();
let stopCxByName: Map<string, Map<string, number>> = new Map();
let globalStopNames: Map<string, string> = new Map();

// tripId → ordered stop time entries. Loaded in bulk after each poll via
// loadMissingStopTimes(). Empty array means "loaded but no data".
export interface StopTimeEntry { seq: number; stopId: string; arrivalSec: number; departureSec: number; }
const tripStopTimesCache = new Map<string, StopTimeEntry[]>();

// stopId → lineId → dwell stats. Loaded from DB after patronage reload.
// Outer key stopId, inner key lineId.
type DwellEntry = { baseDwellSec: number; peakDwellSec: number; offpeakDwellSec: number };
let dwellStats: Map<string, Map<string, DwellEntry>> = new Map();

// ─── Setters (called from app.ts on startup) ─────────────────────────────────

export function setPool(pool: Pool): void { dbPool = pool; }
export function setRouteLineMap(map: Map<string, string>): void { routeLineMap = map; }
export function setTripDirections(map: Map<string, number>): void {
  tripDirections = map;
  console.log(`[app] Loaded ${map.size} trip→direction mappings`);
}
export function setGlobalStopNames(map: Map<string, string>): void { globalStopNames = map; }
export function setDwellStats(map: Map<string, Map<string, DwellEntry>>): void { dwellStats = map; }

export function setLineStopCoords(stops: Map<string, StopData[]>): void {
  lineStops = stops;
  stopCxByLine = new Map();
  stopCxByName = new Map();
  for (const [lineId, coords] of stops) {
    stopCxByLine.set(lineId, new Map(coords.map(c => [c.stopId, c.canonicalX])));
    stopCxByName.set(lineId, new Map(coords.map(c => [normalizeName(c.stopName), c.canonicalX])));
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.replace(/ Station$/, '').replace(/ Platform \d+$/, '').toLowerCase().trim();
}

// Returns the Unix epoch of midnight in the Melbourne local timezone (DST-aware).
export function getMelbourneMidnightEpoch(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value);
  const s = parseInt(parts.find(p => p.type === 'second')!.value);
  return Math.floor(now.getTime() / 1000) - (h * 3600 + m * 60 + s);
}

// Formats an epoch as a Melbourne local time string "HH:MM:SS" for logging.
export function epochToMelbTime(epoch: number): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ─── Stop-times cache ─────────────────────────────────────────────────────────

/** Batch-loads stop_times for any tripIds not yet cached. Called after each poll. */
export async function loadMissingStopTimes(tripIds: string[]): Promise<void> {
  if (!dbPool) return;
  const missing = tripIds.filter(id => !tripStopTimesCache.has(id));
  if (!missing.length) return;

  const { rows } = await dbPool.query<{
    trip_id: string; stop_sequence: number; stop_id: string;
    arrival_time: number; departure_time: number;
  }>(
    `SELECT trip_id, stop_sequence, stop_id, arrival_time, departure_time
     FROM stop_times WHERE trip_id = ANY($1) ORDER BY trip_id, stop_sequence`,
    [missing],
  );

  // Group by trip
  const grouped = new Map<string, StopTimeEntry[]>();
  for (const row of rows) {
    let list = grouped.get(row.trip_id);
    if (!list) { list = []; grouped.set(row.trip_id, list); }
    list.push({ seq: row.stop_sequence, stopId: row.stop_id, arrivalSec: row.arrival_time, departureSec: row.departure_time });
  }

  for (const id of missing) {
    tripStopTimesCache.set(id, grouped.get(id) ?? []);
  }
  if (missing.length > 0) {
    console.log(`[publisher] Cached stop_times for ${grouped.size}/${missing.length} new trips`);
  }
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

export function setTripStopTimesCache(tripId: string, entries: StopTimeEntry[]): void {
  tripStopTimesCache.set(tripId, entries);
}

export function getTripStopTimesCache(tripId: string): StopTimeEntry[] {
  return tripStopTimesCache.get(tripId) ?? [];
}

export function getGlobalStopName(stopId: string): string | undefined {
  return globalStopNames.get(stopId);
}

/**
 * Builds a name-keyed index of stop_times entries so we can resolve stops whose
 * stop_id differs from the one stored in line_station_order (e.g. different
 * platform IDs across trip variants). Key is normalizeName(stop_name).
 */
export function buildStopTimeNameIndex(stopTimes: StopTimeEntry[]): Map<string, StopTimeEntry> {
  const idx = new Map<string, StopTimeEntry>();
  for (const e of stopTimes) {
    const name = globalStopNames.get(e.stopId);
    if (name) idx.set(normalizeName(name), e);
  }
  return idx;
}

/**
 * Builds the merged static+TU upcoming stop schedule for a trip.
 * Returns all stops whose canonicalX is ahead of the train's current position.
 */
function buildUpcomingStops(
  tripId: string,
  canonicalX: number,
  directionId: number | null,
  tu: TripUpdateEntry,
  lineCxMap: Map<string, number>,
  lineId: string,
  midnight: number,
): UpcomingStop[] {
  const stopTimes = tripStopTimesCache.get(tripId);
  if (!stopTimes?.length) return [];

  // Index TU updates by stopId and stopSeq for O(1) lookup
  const tuByStopId = new Map(tu.allStopUpdates.map(u => [u.stopId, u]));
  const tuByStopSeq = new Map(tu.allStopUpdates.map(u => [u.stopSeq, u]));

  // Outbound (dir=0): increasing canonicalX; inbound (dir=1): decreasing canonicalX
  const forward = directionId !== 1;

  // Name-keyed cx fallback: individual trips may use a different platform stop_id
  // than the one chosen by the line_station_order view (MIN(stop_id)).
  const lineCxByName = stopCxByName.get(lineId) ?? new Map<string, number>();

  const upcoming: UpcomingStop[] = [];
  for (const st of stopTimes) {
    let cx = lineCxMap.get(st.stopId) ?? -1;
    if (cx < 0) {
      const name = globalStopNames.get(st.stopId);
      if (name) cx = lineCxByName.get(normalizeName(name)) ?? -1;
    }
    // Skip stops the train has already passed
    if (cx >= 0 && (forward ? cx <= canonicalX : cx >= canonicalX)) continue;

    const scheduledArrivalEpoch = midnight + st.arrivalSec;
    const tuUpdate = tuByStopId.get(st.stopId) ?? tuByStopSeq.get(st.seq);
    const tuDelay = tuUpdate ? (tuUpdate.arrivalDelay || tuUpdate.departureDelay || null) : null;
    const effectiveDelay = tuDelay ?? tu.delay;
    const adjustedArrivalEpoch = tuUpdate?.arrivalEpoch
      ? tuUpdate.arrivalEpoch
      : scheduledArrivalEpoch + effectiveDelay;

    upcoming.push({
      stopId: st.stopId,
      stopName: globalStopNames.get(st.stopId) ?? st.stopId,
      canonicalX: cx,
      scheduledArrivalEpoch,
      adjustedArrivalEpoch,
      predictedArrivalEpoch: 0, // filled in below
      tuDelaySeconds: tuDelay,
    });
  }

  return upcoming;
}

// Peak: 07:00–09:00 and 16:00–18:30 local
function isPeakNow(): boolean {
  const now = new Date();
  const melb = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }));
  const sec = melb.getHours() * 3600 + melb.getMinutes() * 60 + melb.getSeconds();
  return (sec >= 7 * 3600 && sec < 9 * 3600) || (sec >= 16 * 3600 && sec < 18.5 * 3600);
}

/**
 * Fills in predictedArrivalEpoch for each upcoming stop by propagating the
 * speed-based next-stop prediction forward using adjusted schedule gaps.
 *
 * Adds per-stop dwell time when the GTFS schedule encodes no dwell
 * (departure_time == arrival_time). Uses patronage-derived dwell estimates
 * (peak or offpeak) loaded from stop_dwell_stats.
 */
function fillPredictedArrivals(
  upcoming: UpcomingStop[],
  predictedNextArrival: number,
  lineId: string,
  stopTimes: Map<string, StopTimeEntry>,  // stopId → entry for this trip
): void {
  if (!upcoming.length || !predictedNextArrival) return;

  const peak = isPeakNow();
  const baseAdjusted = upcoming[0].adjustedArrivalEpoch;

  // Cumulative dwell offset added for stops between nextStop and this stop.
  // This accounts for intermediate stops where GTFS has no dwell encoded.
  let cumulativeDwellOffset = 0;

  for (let i = 0; i < upcoming.length; i++) {
    const stop = upcoming[i];
    const gapFromNext = stop.adjustedArrivalEpoch - baseAdjusted;
    stop.predictedArrivalEpoch = predictedNextArrival + gapFromNext + cumulativeDwellOffset;

    // Add dwell for this stop so the NEXT stop's prediction accounts for us stopping here.
    // Only add dwell if GTFS doesn't already encode it (departure == arrival).
    if (i < upcoming.length - 1) {
      const st = stopTimes.get(stop.stopId);
      const gtfsDwell = st ? Math.max(0, st.departureSec - st.arrivalSec) : 0;

      const lineMap = dwellStats.get(stop.stopId);
      const dwell = lineMap?.get(lineId);
      const estimatedDwell = dwell
        ? (peak ? dwell.peakDwellSec : dwell.offpeakDwellSec)
        : 20; // default 20s when no patronage data

      const extraDwell = Math.max(0, estimatedDwell - gtfsDwell);
      cumulativeDwellOffset += extraDwell;
    }
  }
}

// ─── Admin / inspector helpers ────────────────────────────────────────────────

export interface LineCount {
  lineId: string;
  count: number;
  delta: number | null;
}

export interface PublishStats {
  vehicleCount: number;
  vehiclesByLine: LineCount[];
  unmappedCount: number;
  tuMatchCount: number;
  redisVehicleCount: number;
  snapshotAt: string | null;
}

let lastPublishStats: PublishStats = {
  vehicleCount: 0, vehiclesByLine: [], unmappedCount: 0,
  tuMatchCount: 0, redisVehicleCount: 0, snapshotAt: null,
};
let prevByLineCount = new Map<string, number>();

export function getPublishStats(): PublishStats { return { ...lastPublishStats }; }

export function getStopsForLine(lineId: string): StopData[] {
  return lineStops.get(lineId) ?? [];
}

export function getPrevNextStopNames(
  lineId: string,
  canonicalX: number,
  nextStopId: string | null,
): { prevStopName: string | null; nextStopName: string | null } {
  const stops = lineStops.get(lineId) ?? [];
  let nextStop = nextStopId ? stops.find(s => s.stopId === nextStopId) : null;
  if (!nextStop && nextStopId) {
    const name = globalStopNames.get(nextStopId);
    if (name) nextStop = stops.find(s => normalizeName(s.stopName) === normalizeName(name)) ?? null;
  }
  const prevStop = [...stops].reverse().find(s => s.canonicalX <= canonicalX) ?? null;
  return {
    prevStopName: prevStop?.stopName ?? null,
    nextStopName: nextStop?.stopName ?? null,
  };
}

// ─── Core publish loop ────────────────────────────────────────────────────────

export async function publishPositions(
  io: Server,
  positions: VehiclePosition[],
  tripUpdates: Map<string, TripUpdateEntry>,
): Promise<void> {
  const byLine = new Map<string, LivePosition[]>();
  let unmappedCount = 0;
  let tuMatchCount = 0;
  const midnight = getMelbourneMidnightEpoch();
  const now = Date.now() / 1000;

  for (const pos of positions) {
    if (!pos.tripId) continue;

    const lineId = pos.routeId ? routeLineMap.get(pos.routeId) : undefined;
    if (!lineId) { unmappedCount++; continue; }

    const stops = lineStops.get(lineId) ?? [];
    const lineCxMap = stopCxByLine.get(lineId) ?? new Map<string, number>();
    const canonicalX = projectToLine(pos.lat, pos.lon, stops);

    const directionId = tripDirections.get(pos.tripId) ?? null;
    const forward = directionId !== 1;

    // ── TU lookup first — drives segment detection ─────────────────────────────
    const tu = tripUpdates.get(pos.tripId);

    // Prefer TU-derived segment: trip update knows the authoritative next stop.
    // GPS alone can be misleading near terminus or with position noise.
    let seg = tu?.nextStopId
      ? findSegmentFromTU(stops, tu.nextStopId, forward)
      : { prevStop: null, nextStop: null };

    // Name fallback: TU may use an alternate-platform stop ID not in our line list
    // (e.g. direction_id=1 uses a different platform stop). Try resolving by name.
    if (!seg.nextStop && tu?.nextStopId) {
      const altName = globalStopNames.get(tu.nextStopId);
      if (altName) {
        const matchStop = stops.find(s => s.stopName === altName);
        if (matchStop) seg = findSegmentFromTU(stops, matchStop.stopId, forward);
      }
    }

    // Final fallback: GPS projection
    if (!seg.nextStop) seg = findSegmentStops(stops, canonicalX, forward);

    // Trip-terminus override: if prevStop is the trip's last scheduled stop,
    // discard any further next stop that TU or GPS suggests. This is authoritative
    // over all other signals — GPS noise near terminus can flip the segment back.
    if (seg.prevStop) {
      const stopTimes = tripStopTimesCache.get(pos.tripId) ?? [];
      if (stopTimes.length) {
        const last = stopTimes[stopTimes.length - 1];
        const lastGlobalName = globalStopNames.get(last.stopId);
        const atTerminus = last.stopId === seg.prevStop.stopId
          || (lastGlobalName != null && normalizeName(lastGlobalName) === normalizeName(seg.prevStop.stopName));
        if (atTerminus) seg = { prevStop: seg.prevStop, nextStop: null };
      }
    }

    const { prevStop, nextStop } = seg;

    let delay = 0;
    let nextArrivalEpoch = 0;
    let scheduledNextArrivalEpoch = 0;
    let predictedNextArrivalEpoch = 0;
    let segmentSpeedKmh: number | null = null;
    let upcomingStops: UpcomingStop[] = [];

    if (tu) {
      tuMatchCount++;
      delay = tu.delay;

      // Schedule-based ETA using TU-derived segment stops
      const stopTimes = tripStopTimesCache.get(pos.tripId);
      if (stopTimes?.length && prevStop && nextStop) {
        const stopTimesById = new Map(stopTimes.map(e => [e.stopId, e]));
        const stopTimesByName = buildStopTimeNameIndex(stopTimes);
        const prevEntry = stopTimesById.get(prevStop.stopId)
          ?? stopTimesByName.get(normalizeName(prevStop.stopName))
          ?? null;
        const nextEntry = stopTimesById.get(nextStop.stopId)
          ?? stopTimesByName.get(normalizeName(nextStop.stopName))
          ?? null;

        const pred = computeSegmentPrediction(
          prevStop, nextStop, prevEntry, nextEntry, delay, canonicalX, now, midnight,
          pos.timestamp, // GPS capture time — may be 30-60s older than now
        );
        scheduledNextArrivalEpoch = pred.scheduledNextArrivalEpoch;
        nextArrivalEpoch          = pred.nextArrivalEpoch;
        predictedNextArrivalEpoch = pred.predictedNextArrivalEpoch;
        segmentSpeedKmh           = pred.segmentSpeedKmh;
      }

      // Build merged upcoming schedule with dwell-adjusted predicted arrivals
      upcomingStops = buildUpcomingStops(pos.tripId, canonicalX, directionId, tu, lineCxMap, lineId, midnight);
      if (predictedNextArrivalEpoch > 0) {
        const stopTimesById = new Map((tripStopTimesCache.get(pos.tripId) ?? []).map(e => [e.stopId, e]));
        fillPredictedArrivals(upcomingStops, predictedNextArrivalEpoch, lineId, stopTimesById);
      }
    }

    const nextStopId = nextStop?.stopId ?? tu?.nextStopId ?? null;

    const live: LivePosition = {
      tripId: pos.tripId,
      lineId,
      lat: pos.lat,
      lon: pos.lon,
      bearing: pos.bearing,
      timestamp: pos.timestamp,
      canonicalX,

      prevStopId: prevStop?.stopId ?? null,
      prevStopName: prevStop?.stopName ?? null,
      prevStopCanonicalX: prevStop?.canonicalX ?? -1,

      nextStopId,
      nextStopName: nextStop?.stopName ?? null,
      nextStopCanonicalX: nextStop?.canonicalX ?? -1,

      scheduledNextArrivalEpoch,
      nextArrivalEpoch,
      predictedNextArrivalEpoch,

      delay,
      segmentSpeedKmh,
      directionId,
      upcomingStops,
    };

    await redis.set(keys.vehicle(pos.tripId), JSON.stringify(live), 'EX', 120);
    updateLivePosition(live);

    if (!byLine.has(lineId)) byLine.set(lineId, []);
    byLine.get(lineId)!.push(live);
  }

  for (const [lineId, linePositions] of byLine) {
    const room = `line:${lineId}`;
    if (io.sockets.adapter.rooms.get(room)?.size) {
      io.to(room).emit('vehicles:update', linePositions);
    }
  }

  if (io.sockets.adapter.rooms.get('line:all')?.size) {
    io.to('line:all').emit('vehicles:update', Array.from(byLine.values()).flat());
  }

  const redisVehicleCount = await redis.keys('vehicle:*').then(k => k.length);
  const isFirstPoll = prevByLineCount.size === 0;
  const vehiclesByLine: LineCount[] = Array.from(byLine.entries()).map(([lineId, ps]) => ({
    lineId,
    count: ps.length,
    delta: isFirstPoll ? null : (ps.length - (prevByLineCount.get(lineId) ?? 0)),
  }));
  prevByLineCount = new Map(Array.from(byLine.entries()).map(([lineId, ps]) => [lineId, ps.length]));

  lastPublishStats = {
    vehicleCount: positions.length,
    vehiclesByLine,
    unmappedCount,
    tuMatchCount,
    redisVehicleCount,
    snapshotAt: new Date().toISOString(),
  };
}
