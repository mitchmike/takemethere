/**
 * Poll output: enriches raw vehicle positions into LivePositions, writes to Redis,
 * and emits vehicles:update to subscribed Socket.io rooms.
 *
 * "Publisher" in the HFT sense: the final stage of the on-poll pipeline
 * (ingest → enrich → publish).
 */

import type { Server } from 'socket.io';
import type { VehiclePosition, LivePosition, UpcomingStop } from '@takemethere/shared';
import { projectToLine } from '@takemethere/shared';
import type { TripUpdateEntry } from '../ingest/position_decoder.js';
import { redis } from '../../redis/client.js';
import { keys } from '../../redis/keys.js';
import { updateLivePosition } from '../engine/position_store.js';
import {
  getRouteLineMap,
  getTripDirection,
  getStopsForLine,
  getStopCxByLine,
  getStopCxByName,
  getGlobalStopName,
  getDwellStats,
  getTripStopTimesCache,
  buildStopTimeNameIndex,
  getMelbourneMidnightEpoch,
  normalizeName,
} from '../engine/static_data.js';
import {
  findSegmentStops,
  findSegmentFromTU,
  computeSegmentPrediction,
} from '../engine/position_enricher.js';

// ─── Stats ────────────────────────────────────────────────────────────────────

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

// ─── Upcoming stop enrichment ─────────────────────────────────────────────────

function isPeakNow(): boolean {
  const now  = new Date();
  const melb = new Date(now.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }));
  const sec  = melb.getHours() * 3600 + melb.getMinutes() * 60 + melb.getSeconds();
  return (sec >= 7 * 3600 && sec < 9 * 3600) || (sec >= 16 * 3600 && sec < 18.5 * 3600);
}

function buildUpcomingStops(
  tripId: string,
  canonicalX: number,
  directionId: number | null,
  tu: TripUpdateEntry,
  lineCxMap: Map<string, number>,
  lineId: string,
  midnight: number,
): UpcomingStop[] {
  const stopTimes = getTripStopTimesCache(tripId);
  if (!stopTimes?.length) return [];

  const tuByStopId  = new Map(tu.allStopUpdates.map(u => [u.stopId, u]));
  const tuByStopSeq = new Map(tu.allStopUpdates.map(u => [u.stopSeq, u]));
  const forward     = directionId !== 1;
  const lineCxByName = getStopCxByName(lineId);

  const upcoming: UpcomingStop[] = [];
  for (const st of stopTimes) {
    let cx = lineCxMap.get(st.stopId) ?? -1;
    if (cx < 0) {
      const name = getGlobalStopName(st.stopId);
      if (name) cx = lineCxByName.get(normalizeName(name)) ?? -1;
    }
    if (cx >= 0 && (forward ? cx <= canonicalX : cx >= canonicalX)) continue;

    const scheduledArrivalEpoch = midnight + st.arrivalSec;
    const tuUpdate      = tuByStopId.get(st.stopId) ?? tuByStopSeq.get(st.seq);
    const tuDelay       = tuUpdate ? (tuUpdate.arrivalDelay || tuUpdate.departureDelay || null) : null;
    const effectiveDelay = tuDelay ?? tu.delay;
    const adjustedArrivalEpoch = tuUpdate?.arrivalEpoch
      ? tuUpdate.arrivalEpoch
      : scheduledArrivalEpoch + effectiveDelay;

    upcoming.push({
      stopId: st.stopId,
      stopName: getGlobalStopName(st.stopId) ?? st.stopId,
      canonicalX: cx,
      scheduledArrivalEpoch,
      adjustedArrivalEpoch,
      predictedArrivalEpoch: 0,
      tuDelaySeconds: tuDelay,
    });
  }
  return upcoming;
}

function fillPredictedArrivals(
  upcoming: UpcomingStop[],
  predictedNextArrival: number,
  lineId: string,
  stopTimesById: Map<string, { arrivalSec: number; departureSec: number }>,
): void {
  if (!upcoming.length || !predictedNextArrival) return;

  const peak = isPeakNow();
  const baseAdjusted = upcoming[0].adjustedArrivalEpoch;
  const dwellStats   = getDwellStats();
  let cumulativeDwellOffset = 0;

  for (let i = 0; i < upcoming.length; i++) {
    const stop = upcoming[i];
    const gapFromNext = stop.adjustedArrivalEpoch - baseAdjusted;
    stop.predictedArrivalEpoch = predictedNextArrival + gapFromNext + cumulativeDwellOffset;

    if (i < upcoming.length - 1) {
      const st        = stopTimesById.get(stop.stopId);
      const gtfsDwell = st ? Math.max(0, st.departureSec - st.arrivalSec) : 0;
      const lineMap   = dwellStats.get(stop.stopId);
      const dwell     = lineMap?.get(lineId);
      const estimated = dwell
        ? (peak ? dwell.peakDwellSec : dwell.offpeakDwellSec)
        : 20;
      cumulativeDwellOffset += Math.max(0, estimated - gtfsDwell);
    }
  }
}

// ─── Core publish pipeline ────────────────────────────────────────────────────

export async function publishPositions(
  io: Server,
  positions: VehiclePosition[],
  tripUpdates: Map<string, TripUpdateEntry>,
): Promise<void> {
  const byLine       = new Map<string, LivePosition[]>();
  let unmappedCount  = 0;
  let tuMatchCount   = 0;
  const midnight     = getMelbourneMidnightEpoch();
  const now          = Date.now() / 1000;
  const routeLineMap = getRouteLineMap();

  for (const pos of positions) {
    if (!pos.tripId) continue;

    const lineId = pos.routeId ? routeLineMap.get(pos.routeId) : undefined;
    if (!lineId) { unmappedCount++; continue; }

    const stops     = getStopsForLine(lineId);
    const lineCxMap = getStopCxByLine(lineId);
    const canonicalX = projectToLine(pos.lat, pos.lon, stops);
    const directionId = getTripDirection(pos.tripId);
    const forward   = directionId !== 1;

    const tu = tripUpdates.get(pos.tripId);

    let seg = tu?.nextStopId
      ? findSegmentFromTU(stops, tu.nextStopId, forward)
      : { prevStop: null, nextStop: null };

    if (!seg.nextStop && tu?.nextStopId) {
      const altName = getGlobalStopName(tu.nextStopId);
      if (altName) {
        const matchStop = stops.find(s => s.stopName === altName);
        if (matchStop) seg = findSegmentFromTU(stops, matchStop.stopId, forward);
      }
    }

    if (!seg.nextStop) seg = findSegmentStops(stops, canonicalX, forward);

    if (seg.prevStop) {
      const stopTimes = getTripStopTimesCache(pos.tripId);
      if (stopTimes.length) {
        const last = stopTimes[stopTimes.length - 1];
        const lastGlobalName = getGlobalStopName(last.stopId);
        const atTerminus = last.stopId === seg.prevStop.stopId
          || (lastGlobalName != null && normalizeName(lastGlobalName) === normalizeName(seg.prevStop.stopName));
        if (atTerminus) seg = { prevStop: seg.prevStop, nextStop: null };
      }
    }

    const { prevStop, nextStop } = seg;

    let delay = 0;
    let nextArrivalEpoch          = 0;
    let scheduledNextArrivalEpoch = 0;
    let predictedNextArrivalEpoch = 0;
    let segmentSpeedKmh: number | null = null;
    let upcomingStops: UpcomingStop[]  = [];

    if (tu) {
      tuMatchCount++;
      delay = tu.delay;

      const stopTimes = getTripStopTimesCache(pos.tripId);
      if (stopTimes?.length && prevStop && nextStop) {
        const stopTimesById   = new Map(stopTimes.map(e => [e.stopId, e]));
        const stopTimesByName = buildStopTimeNameIndex(stopTimes);
        const prevEntry = stopTimesById.get(prevStop.stopId)
          ?? stopTimesByName.get(normalizeName(prevStop.stopName))
          ?? null;
        const nextEntry = stopTimesById.get(nextStop.stopId)
          ?? stopTimesByName.get(normalizeName(nextStop.stopName))
          ?? null;

        const pred = computeSegmentPrediction(
          prevStop, nextStop, prevEntry, nextEntry, delay, canonicalX, now, midnight, pos.timestamp,
        );
        scheduledNextArrivalEpoch = pred.scheduledNextArrivalEpoch;
        nextArrivalEpoch          = pred.nextArrivalEpoch;
        predictedNextArrivalEpoch = pred.predictedNextArrivalEpoch;
        segmentSpeedKmh           = pred.segmentSpeedKmh;
      }

      upcomingStops = buildUpcomingStops(pos.tripId, canonicalX, directionId, tu, lineCxMap, lineId, midnight);
      if (predictedNextArrivalEpoch > 0) {
        const stopTimesById = new Map((getTripStopTimesCache(pos.tripId)).map(e => [e.stopId, e]));
        fillPredictedArrivals(upcomingStops, predictedNextArrivalEpoch, lineId, stopTimesById);
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
      prevStopId:   prevStop?.stopId   ?? null,
      prevStopName: prevStop?.stopName ?? null,
      prevStopCanonicalX: prevStop?.canonicalX ?? -1,
      nextStopId:   nextStop?.stopId   ?? null,
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
