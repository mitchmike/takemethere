import type { Server } from 'socket.io';
import type { VehiclePosition, LivePosition } from '@takemethere/shared';
import { projectToLine } from '@takemethere/shared';
import type { StopCoord } from '@takemethere/shared';
import type { TripUpdateEntry } from './decoder.js';
import { redis } from '../redis/client.js';
import { keys } from '../redis/keys.js';

// StopCoord extended with stop name for admin inspector lookups
export interface StopData extends StopCoord {
  stopName: string;
}

let routeLineMap: Map<string, string> = new Map();

// tripId → direction_id from GTFS static (0=outbound, 1=inbound)
let tripDirections: Map<string, number> = new Map();

// Per-line stop list sorted by canonicalX
let lineStops: Map<string, StopData[]> = new Map();

// stopId → canonicalX per line (O(1) primary lookup)
let stopCxByLine: Map<string, Map<string, number>> = new Map();

// Normalized stop name → canonicalX per line (fallback when TU gives the other direction's platform stopId)
let stopCxByName: Map<string, Map<string, number>> = new Map();

// Global stopId → stop name (all stops in DB, used for name-based fallback)
let globalStopNames: Map<string, string> = new Map();

function normalizeName(name: string): string {
  return name.replace(/ Station$/, '').replace(/ Platform \d+$/, '').toLowerCase().trim();
}

export interface LineCount {
  lineId: string;
  count: number;
  delta: number | null; // null = no previous data
}

export interface PublishStats {
  vehicleCount: number;
  vehiclesByLine: LineCount[];
  unmappedCount: number;
  tuMatchCount: number;        // how many VP entries had a matching TU
  redisVehicleCount: number;
  snapshotAt: string | null;   // ISO timestamp of last poll
}

let lastPublishStats: PublishStats = {
  vehicleCount: 0,
  vehiclesByLine: [],
  unmappedCount: 0,
  tuMatchCount: 0,
  redisVehicleCount: 0,
  snapshotAt: null,
};

// Previous poll's per-line counts for delta computation
let prevByLineCount = new Map<string, number>();

export function setRouteLineMap(map: Map<string, string>): void {
  routeLineMap = map;
}

export function setTripDirections(map: Map<string, number>): void {
  tripDirections = map;
  console.log(`[app] Loaded ${map.size} trip→direction mappings`);
}

export function setGlobalStopNames(map: Map<string, string>): void {
  globalStopNames = map;
}

export function setLineStopCoords(stops: Map<string, StopData[]>): void {
  lineStops = stops;
  stopCxByLine = new Map();
  stopCxByName = new Map();
  for (const [lineId, coords] of stops) {
    stopCxByLine.set(lineId, new Map(coords.map(c => [c.stopId, c.canonicalX])));
    stopCxByName.set(lineId, new Map(coords.map(c => [normalizeName(c.stopName), c.canonicalX])));
  }
}

/** Returns the stops list for a line, used by the admin inspector endpoint. */
export function getStopsForLine(lineId: string): StopData[] {
  return lineStops.get(lineId) ?? [];
}

/**
 * Given a vehicle's lineId, GPS-projected canonicalX, and nextStopId from TU,
 * returns the human-readable previous and next stop names.
 */
export function getPrevNextStopNames(
  lineId: string,
  canonicalX: number,
  nextStopId: string | null,
): { prevStopName: string | null; nextStopName: string | null } {
  const stops = lineStops.get(lineId) ?? [];
  // Try direct stopId match first, then fall back to stop name lookup
  let nextStop = nextStopId ? stops.find(s => s.stopId === nextStopId) : null;
  if (!nextStop && nextStopId) {
    const name = globalStopNames.get(nextStopId);
    if (name) nextStop = stops.find(s => normalizeName(s.stopName) === normalizeName(name)) ?? null;
  }
  // Last stop whose canonicalX is <= vehicle's position
  const prevStop = [...stops].reverse().find(s => s.canonicalX <= canonicalX) ?? null;
  return {
    prevStopName: prevStop?.stopName ?? null,
    nextStopName: nextStop?.stopName ?? null,
  };
}

export function getPublishStats(): PublishStats {
  return { ...lastPublishStats };
}

export async function publishPositions(
  io: Server,
  positions: VehiclePosition[],
  tripUpdates: Map<string, TripUpdateEntry>,
): Promise<void> {
  const byLine = new Map<string, LivePosition[]>();
  let unmappedCount = 0;
  let tuMatchCount = 0;

  for (const pos of positions) {
    if (!pos.tripId) continue;

    const lineId = pos.routeId ? routeLineMap.get(pos.routeId) : undefined;
    if (!lineId) { unmappedCount++; continue; }

    const stops = lineStops.get(lineId) ?? [];
    const canonicalX = projectToLine(pos.lat, pos.lon, stops);

    // Enrich with trip update data
    const tu = tripUpdates.get(pos.tripId);
    let delay = 0;
    let nextStopId: string | null = null;
    let nextStopCanonicalX = -1;
    let nextArrivalEpoch = 0;

    if (tu) {
      tuMatchCount++;
      delay = tu.delay;
      nextStopId = tu.nextStopId;
      nextArrivalEpoch = tu.nextArrivalEpoch;

      if (nextStopId) {
        nextStopCanonicalX = stopCxByLine.get(lineId)?.get(nextStopId) ?? -1;
        // Fallback: TU may use a different platform's stopId (e.g. direction_id=1 vs the
        // direction_id=0 stops in line_station_order). Resolve via stop name.
        if (nextStopCanonicalX < 0) {
          const stopName = globalStopNames.get(nextStopId);
          if (stopName) {
            nextStopCanonicalX = stopCxByName.get(lineId)?.get(normalizeName(stopName)) ?? -1;
          }
        }
      }
    }

    const live: LivePosition = {
      tripId: pos.tripId,
      lineId,
      lat: pos.lat,
      lon: pos.lon,
      bearing: pos.bearing,
      timestamp: pos.timestamp,
      canonicalX,
      delay,
      nextStopId,
      nextStopCanonicalX,
      nextArrivalEpoch,
      directionId: pos.tripId ? (tripDirections.get(pos.tripId) ?? null) : null,
    };

    await redis.set(keys.vehicle(pos.tripId), JSON.stringify(live), 'EX', 120);

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
    const all = Array.from(byLine.values()).flat();
    io.to('line:all').emit('vehicles:update', all);
  }

  const redisVehicleCount = await redis.keys('vehicle:*').then(k => k.length);

  const isFirstPoll = prevByLineCount.size === 0;
  const vehiclesByLine: LineCount[] = Array.from(byLine.entries()).map(([lineId, ps]) => ({
    lineId,
    count: ps.length,
    delta: isFirstPoll ? null : (ps.length - (prevByLineCount.get(lineId) ?? 0)),
  }));

  // Update previous counts for next poll's delta
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
