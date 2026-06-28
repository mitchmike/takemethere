import type { Server } from 'socket.io';
import type { LivePosition, StreamedPosition } from '@takemethere/shared';
import {
  getStopsForLine,
  getTripStopTimesCache,
  getGlobalStopName,
  buildStopTimeNameIndex,
  getMelbourneMidnightEpoch,
} from './publisher.js';

// In-memory snapshot of the last published LivePosition per trip.
// Updated by publisher on each poll AND by the streamer when it advances a segment.
const livePositions = new Map<string, LivePosition>();

// Epoch (seconds) when each trip was detected as having reached its trip terminus.
// Used to remove the train ~15s after it completes its service.
const terminusArrivalTime = new Map<string, number>();

const TERMINUS_LINGER_SEC = 15;

export function updateLivePosition(pos: LivePosition): void {
  const existing = livePositions.get(pos.tripId);
  // Once the streamer has advanced a train to terminus (nextStopId = null), don't let
  // GPS poll noise reset it to "approaching terminus" until the trip leaves the feed.
  if (existing && existing.nextStopId === null && pos.nextStopId !== null) return;
  livePositions.set(pos.tripId, pos);
}

export function removeLivePosition(tripId: string): void {
  livePositions.delete(tripId);
  terminusArrivalTime.delete(tripId);
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ─── Normalisation helper (mirrors publisher.ts) ───────────────────────────────

function normalizeName(name: string): string {
  return name.replace(/ Station$/, '').replace(/ Platform \d+$/, '').toLowerCase().trim();
}

// ─── Trip terminus detection ──────────────────────────────────────────────────

/**
 * Returns the stopId of the last stop in this trip's schedule (from the cache),
 * or null if the cache is empty or unknown. Uses a name-based fallback to handle
 * platform ID mismatches between the GTFS-RT feed and our line stop list.
 */
export function getTripLastStopId(tripId: string): string | null {
  const stopTimes = getTripStopTimesCache(tripId);
  if (!stopTimes.length) return null;
  // Entries are in trip order (by seq). Last entry = terminus for this service.
  return stopTimes[stopTimes.length - 1].stopId;
}

/**
 * Returns true if `stopId` (or its stop name) matches the trip's last scheduled stop.
 * Handles platform ID mismatches via name normalisation.
 */
export function isAtTripTerminus(tripId: string, stopId: string, stopName: string): boolean {
  const stopTimes = getTripStopTimesCache(tripId);
  if (!stopTimes.length) return false;
  const last = stopTimes[stopTimes.length - 1];
  if (last.stopId === stopId) return true;
  // Name fallback: platform-specific IDs won't match by ID but will by name
  const lastGlobalName = getGlobalStopName(last.stopId);
  if (lastGlobalName && normalizeName(lastGlobalName) === normalizeName(stopName)) return true;
  return false;
}

// ─── Interpolation ────────────────────────────────────────────────────────────

// Exported for testing
export function computeInterpolatedX(pos: LivePosition, nowSec?: number): number {
  const now = nowSec ?? Date.now() / 1000;

  // Prefer predictedNextArrivalEpoch (GPS-derived, always future) over
  // nextArrivalEpoch (schedule + delay, can be in the past for late trains).
  const arrivalEpoch = pos.predictedNextArrivalEpoch > 0
    ? pos.predictedNextArrivalEpoch
    : pos.nextArrivalEpoch;

  const hasNext = arrivalEpoch > pos.timestamp
    && pos.nextStopCanonicalX >= 0
    && Math.abs(pos.nextStopCanonicalX - pos.canonicalX) > 0.002;

  if (!hasNext) return pos.canonicalX;

  const elapsed = now - pos.timestamp;
  const total   = arrivalEpoch - pos.timestamp;
  if (total <= 0 || elapsed < 0) return pos.canonicalX;

  const t   = Math.min(1, elapsed / total);
  const raw = pos.canonicalX + t * (pos.nextStopCanonicalX - pos.canonicalX);
  const lo  = Math.min(pos.canonicalX, pos.nextStopCanonicalX);
  const hi  = Math.max(pos.canonicalX, pos.nextStopCanonicalX);
  return Math.max(lo, Math.min(hi, raw));
}

// ─── Segment advance ──────────────────────────────────────────────────────────

/**
 * When the interpolated position crosses the next stop, advances the segment in the
 * LivePosition so the streamer doesn't go stale between polls. Returns the updated
 * LivePosition if a crossing was detected, null otherwise.
 *
 * If the crossing stop is the trip's last scheduled stop (regardless of whether
 * more stops exist on the line), returns a terminus LivePosition with nextStopId=null.
 */
export function tryAdvanceSegment(pos: LivePosition, interpX: number, nowSec: number): LivePosition | null {
  if (!pos.nextStopId || pos.nextStopCanonicalX < 0) return null;

  const forward = pos.directionId !== 1;
  const crossed = forward
    ? interpX >= pos.nextStopCanonicalX
    : interpX <= pos.nextStopCanonicalX;
  if (!crossed) return null;

  const stops = getStopsForLine(pos.lineId);

  // Primary lookup by stopId; name fallback for platform ID mismatches.
  let nextIdx = stops.findIndex(s => s.stopId === pos.nextStopId);
  if (nextIdx < 0 && pos.nextStopName) {
    nextIdx = stops.findIndex(s => normalizeName(s.stopName) === normalizeName(pos.nextStopName ?? ''));
  }
  if (nextIdx < 0) return null;

  const newPrevStop = stops[nextIdx];

  // If this stop is the trip's last scheduled stop, treat as trip terminus
  // regardless of whether more stops exist on the line.
  const tripTerminus = isAtTripTerminus(pos.tripId, newPrevStop.stopId, newPrevStop.stopName);

  const newNextIdx  = (!tripTerminus && forward) ? nextIdx + 1
                    : (!tripTerminus && !forward) ? nextIdx - 1
                    : -1; // terminus
  const newNextStop = (newNextIdx >= 0 && newNextIdx < stops.length) ? stops[newNextIdx] : null;

  let scheduledNextArrivalEpoch = 0;
  let nextArrivalEpoch          = 0;
  let predictedNextArrivalEpoch = 0;

  if (newNextStop) {
    const stopTimes      = getTripStopTimesCache(pos.tripId);
    const byId           = new Map(stopTimes.map(e => [e.stopId, e]));
    const byName         = buildStopTimeNameIndex(stopTimes);

    const newPrevEntry = byId.get(newPrevStop.stopId)
      ?? byName.get(normalizeName(getGlobalStopName(newPrevStop.stopId) ?? newPrevStop.stopName))
      ?? null;
    const newNextEntry = byId.get(newNextStop.stopId)
      ?? byName.get(normalizeName(getGlobalStopName(newNextStop.stopId) ?? newNextStop.stopName))
      ?? null;

    const midnight = getMelbourneMidnightEpoch();

    if (newNextEntry) {
      scheduledNextArrivalEpoch = midnight + newNextEntry.arrivalSec;
      nextArrivalEpoch          = scheduledNextArrivalEpoch + pos.delay;
    }

    if (newPrevEntry && newNextEntry) {
      const segDuration = newNextEntry.arrivalSec - newPrevEntry.departureSec;
      if (segDuration > 0) predictedNextArrivalEpoch = nowSec + segDuration;
    }

    if (!predictedNextArrivalEpoch) {
      predictedNextArrivalEpoch = nextArrivalEpoch > nowSec ? nextArrivalEpoch : nowSec + 90;
    }
  }

  return {
    ...pos,
    timestamp:    nowSec,
    canonicalX:   newPrevStop.canonicalX,

    prevStopId:         newPrevStop.stopId,
    prevStopName:       newPrevStop.stopName,
    prevStopCanonicalX: newPrevStop.canonicalX,

    nextStopId:         newNextStop?.stopId       ?? null,
    nextStopName:       newNextStop?.stopName      ?? null,
    nextStopCanonicalX: newNextStop?.canonicalX    ?? -1,

    scheduledNextArrivalEpoch,
    nextArrivalEpoch,
    predictedNextArrivalEpoch,
  };
}

// ─── Stream loop ──────────────────────────────────────────────────────────────

export function startStreamer(io: Server, intervalMs = 1000): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    const nowSec = Date.now() / 1000;
    const byLine = new Map<string, StreamedPosition[]>();
    const toRemove: string[] = [];

    for (let [tripId, pos] of livePositions) {
      if (pos.canonicalX < 0) continue;
      const room = `line:${pos.lineId}`;
      if (!io.sockets.adapter.rooms.get(room)?.size) continue;

      let interpX = computeInterpolatedX(pos, nowSec);

      // Detect segment crossing and advance in-memory position
      const advanced = tryAdvanceSegment(pos, interpX, nowSec);
      if (advanced) {
        livePositions.set(tripId, advanced);
        pos = advanced;
        interpX = computeInterpolatedX(pos, nowSec);
      }

      // If at terminus (no next stop), freeze position and mark atStation.
      const atTerminus = !pos.nextStopId && pos.nextStopCanonicalX < 0;
      const atStation = atTerminus || (
        pos.prevStopCanonicalX >= 0
        && Math.abs(interpX - pos.prevStopCanonicalX) < 0.005
      );

      // Track when the train first reached terminus and remove after linger period.
      if (atTerminus) {
        if (!terminusArrivalTime.has(tripId)) {
          terminusArrivalTime.set(tripId, nowSec);
          console.log(`[streamer] ${tripId} reached trip terminus at ${pos.prevStopName ?? '?'}`);
        }
        const lingered = nowSec - terminusArrivalTime.get(tripId)!;
        if (lingered >= TERMINUS_LINGER_SEC) {
          toRemove.push(tripId);
          continue;
        }
      }

      const streamed: StreamedPosition = {
        tripId,
        canonicalX: atTerminus ? pos.canonicalX : interpX,

        prevStopId:         pos.prevStopId,
        prevStopName:       pos.prevStopName,
        prevStopCanonicalX: pos.prevStopCanonicalX,

        nextStopId:         pos.nextStopId,
        nextStopName:       pos.nextStopName,
        nextStopCanonicalX: pos.nextStopCanonicalX,

        scheduledNextArrivalEpoch: pos.scheduledNextArrivalEpoch,
        nextArrivalEpoch:          pos.nextArrivalEpoch,
        predictedNextArrivalEpoch: pos.predictedNextArrivalEpoch,

        segmentSpeedKmh: pos.segmentSpeedKmh,
        atStation,
      };

      if (!byLine.has(pos.lineId)) byLine.set(pos.lineId, []);
      byLine.get(pos.lineId)!.push(streamed);
    }

    for (const tripId of toRemove) {
      removeLivePosition(tripId);
      console.log(`[streamer] ${tripId} removed after ${TERMINUS_LINGER_SEC}s linger`);
    }

    for (const [lineId, positions] of byLine) {
      io.to(`line:${lineId}`).emit('vehicles:stream', positions);
    }
  }, intervalMs);

  console.log(`[streamer] Started — emitting every ${intervalMs}ms`);
}

export function stopStreamer(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  livePositions.clear();
  terminusArrivalTime.clear();
  console.log('[streamer] Stopped');
}
