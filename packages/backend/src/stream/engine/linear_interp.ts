/**
 * LinearInterpolationEngine — the default position engine.
 *
 * Implements PositionEngine using linear interpolation between the train's last
 * GPS fix and its predicted next-stop arrival. Extracted from streamer.ts so the
 * simulator and future engines can share the same implementation.
 */

import type { LivePosition } from '@takemethere/shared';
import type { PositionEngine } from './types.js';
import {
  getStopsForLine,
  getTripStopTimesCache,
  getGlobalStopName,
  buildStopTimeNameIndex,
  getMelbourneMidnightEpoch,
  normalizeName,
} from './static_data.js';
import { isAtTripTerminus } from './position_store.js';

export class LinearInterpolationEngine implements PositionEngine {
  readonly name = 'linear';

  interpolate(pos: LivePosition, nowSec: number): number {
    return computeInterpolatedX(pos, nowSec);
  }

  tryAdvanceSegment(pos: LivePosition, interpX: number, nowSec: number): LivePosition | null {
    return tryAdvanceSegment(pos, interpX, nowSec);
  }
}

export const linearEngine = new LinearInterpolationEngine();

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Computes the interpolated canonicalX for a train at `nowSec`.
 *
 * Uses predictedNextArrivalEpoch (GPS-derived, anchored at gpsTimestamp) in
 * preference to nextArrivalEpoch (schedule + delay, can be in the past).
 *
 *   elapsed = nowSec − pos.timestamp      (grows from moment of GPS capture)
 *   total   = predictedNextArrivalEpoch − pos.timestamp
 *   t       = clamp(elapsed / total, 0, 1)
 *   interpX = canonicalX + t × (nextStopCanonicalX − canonicalX)
 */
export function computeInterpolatedX(pos: LivePosition, nowSec?: number): number {
  const now = nowSec ?? Date.now() / 1000;

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
 * LivePosition so the emitter doesn't stall between polls.
 *
 * If the crossing stop is the trip's terminus, returns a LivePosition with
 * nextStopId=null (frozen at terminus).
 */
export function tryAdvanceSegment(pos: LivePosition, interpX: number, nowSec: number): LivePosition | null {
  if (!pos.nextStopId || pos.nextStopCanonicalX < 0) return null;

  const forward = pos.directionId !== 1;
  const crossed = forward
    ? interpX >= pos.nextStopCanonicalX
    : interpX <= pos.nextStopCanonicalX;
  if (!crossed) return null;

  const stops = getStopsForLine(pos.lineId);

  let nextIdx = stops.findIndex(s => s.stopId === pos.nextStopId);
  if (nextIdx < 0 && pos.nextStopName) {
    nextIdx = stops.findIndex(s => normalizeName(s.stopName) === normalizeName(pos.nextStopName ?? ''));
  }
  if (nextIdx < 0) return null;

  const newPrevStop = stops[nextIdx];
  const tripTerminus = isAtTripTerminus(pos.tripId, newPrevStop.stopId, newPrevStop.stopName);

  const newNextIdx  = (!tripTerminus && forward)  ? nextIdx + 1
                    : (!tripTerminus && !forward) ? nextIdx - 1
                    : -1;
  const newNextStop = (newNextIdx >= 0 && newNextIdx < stops.length) ? stops[newNextIdx] : null;

  let scheduledNextArrivalEpoch = 0;
  let nextArrivalEpoch          = 0;
  let predictedNextArrivalEpoch = 0;

  if (newNextStop) {
    const stopTimes = getTripStopTimesCache(pos.tripId);
    const byId      = new Map(stopTimes.map(e => [e.stopId, e]));
    const byName    = buildStopTimeNameIndex(stopTimes);

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
