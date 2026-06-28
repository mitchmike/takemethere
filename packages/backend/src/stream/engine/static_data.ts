/**
 * Runtime GTFS static data registry.
 * Loaded once at startup (and after each reload) by app.ts.
 * Consumed by the position engine and publisher.
 */

import type { Pool } from 'pg';
import type { StopCoord } from '@takemethere/shared';

export interface StopData extends StopCoord {
  stopName: string;
}

export interface StopTimeEntry {
  seq: number;
  stopId: string;
  arrivalSec: number;
  departureSec: number;
}

type DwellEntry = { baseDwellSec: number; peakDwellSec: number; offpeakDwellSec: number };

// ─── Registry state ───────────────────────────────────────────────────────────

let dbPool: Pool | null = null;
let routeLineMap: Map<string, string> = new Map();
let tripDirections: Map<string, number> = new Map();
let lineStops: Map<string, StopData[]> = new Map();
let stopCxByLine: Map<string, Map<string, number>> = new Map();
let stopCxByName: Map<string, Map<string, number>> = new Map();
let globalStopNames: Map<string, string> = new Map();
let dwellStats: Map<string, Map<string, DwellEntry>> = new Map();

// tripId → ordered stop time entries. Empty array = "loaded, no data".
const tripStopTimesCache = new Map<string, StopTimeEntry[]>();

// ─── Setters (called from app.ts on startup / reload) ─────────────────────────

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

export function setTripStopTimesCache(tripId: string, entries: StopTimeEntry[]): void {
  tripStopTimesCache.set(tripId, entries);
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getRouteLineMap(): Map<string, string> { return routeLineMap; }
export function getTripDirection(tripId: string): number | null { return tripDirections.get(tripId) ?? null; }
export function getStopsForLine(lineId: string): StopData[] { return lineStops.get(lineId) ?? []; }
export function getStopCxByLine(lineId: string): Map<string, number> { return stopCxByLine.get(lineId) ?? new Map(); }
export function getStopCxByName(lineId: string): Map<string, number> { return stopCxByName.get(lineId) ?? new Map(); }
export function getGlobalStopName(stopId: string): string | undefined { return globalStopNames.get(stopId); }
export function getDwellStats(): Map<string, Map<string, DwellEntry>> { return dwellStats; }
export function getTripStopTimesCache(tripId: string): StopTimeEntry[] { return tripStopTimesCache.get(tripId) ?? []; }
export function hasTripInCache(tripId: string): boolean { return tripStopTimesCache.has(tripId); }

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

/**
 * Builds a name-keyed index of stop_times entries to handle platform ID mismatches
 * where the stop_id in the feed differs from the one in line_station_order.
 */
export function buildStopTimeNameIndex(stopTimes: StopTimeEntry[]): Map<string, StopTimeEntry> {
  const idx = new Map<string, StopTimeEntry>();
  for (const e of stopTimes) {
    const name = globalStopNames.get(e.stopId);
    if (name) idx.set(normalizeName(name), e);
  }
  return idx;
}

// ─── Batch stop-times loader ──────────────────────────────────────────────────

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
    console.log(`[static-data] Cached stop_times for ${grouped.size}/${missing.length} new trips`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function normalizeName(name: string): string {
  return name.replace(/ Station$/, '').replace(/ Platform \d+$/, '').toLowerCase().trim();
}

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

export function epochToMelbTime(epoch: number): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
