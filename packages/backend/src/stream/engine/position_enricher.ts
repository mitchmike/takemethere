/**
 * Pure segment-detection and ETA-prediction functions.
 * No I/O, no side effects — all inputs are passed as arguments.
 * Renamed from segment.ts.
 */

export interface SegmentStop {
  stopId: string;
  canonicalX: number;
  lat: number;
  lon: number;
  stopName: string;
}

export interface StopSchedule {
  stopId: string;
  arrivalSec: number;
  departureSec: number;
}

export interface SegmentResult {
  prevStop: SegmentStop | null;
  nextStop: SegmentStop | null;
}

export interface SegmentPrediction {
  scheduledNextArrivalEpoch: number;
  nextArrivalEpoch: number;
  predictedNextArrivalEpoch: number;
  segmentSpeedKmh: number | null;
}

// ─── Segment detection ────────────────────────────────────────────────────────

/**
 * Finds the stops immediately behind and ahead of a train's GPS canonical position.
 *
 * Outbound (forward=true): canonical X increases.
 *   prevStop = last stop whose cx ≤ train; nextStop = first stop whose cx > train.
 * Inbound (forward=false): canonical X decreases.
 *   prevStop = first stop whose cx ≥ train; nextStop = last stop whose cx < train.
 *
 * `stops` must be sorted by canonicalX ascending.
 */
export function findSegmentStops(
  stops: readonly SegmentStop[],
  canonicalX: number,
  forward: boolean,
): SegmentResult {
  let prevStop: SegmentStop | null = null;
  let nextStop: SegmentStop | null = null;

  for (const s of stops) {
    if (forward) {
      if (s.canonicalX <= canonicalX) prevStop = s;
      else if (!nextStop) { nextStop = s; break; }
    } else {
      if (s.canonicalX < canonicalX) nextStop = s;
      else if (!prevStop) { prevStop = s; break; }
    }
  }

  return { prevStop, nextStop };
}

/**
 * Resolves prevStop/nextStop using the Trip Update's authoritative next-stop ID.
 * Preferred over GPS detection: GPS is noisy near stops and terminus.
 */
export function findSegmentFromTU(
  stops: readonly SegmentStop[],
  tuNextStopId: string,
  forward: boolean,
): SegmentResult {
  const nextIdx = stops.findIndex(s => s.stopId === tuNextStopId);
  if (nextIdx < 0) return { prevStop: null, nextStop: null };
  const nextStop = stops[nextIdx];
  const prevIdx = forward ? nextIdx - 1 : nextIdx + 1;
  const prevStop = prevIdx >= 0 && prevIdx < stops.length ? stops[prevIdx] : null;
  return { prevStop, nextStop };
}

// ─── ETA / speed prediction ───────────────────────────────────────────────────

/**
 * Computes ETA fields for the next stop.
 *
 * `gpsTimestamp` is when the vehicle's GPS was captured — distinct from `now`
 * (publish time, ~30–60s later). Anchoring predictedNextArrivalEpoch to gpsTimestamp
 * means elapsed/total in the engine grows correctly from the moment of capture.
 */
export function computeSegmentPrediction(
  prevStop: SegmentStop,
  nextStop: SegmentStop,
  prevSchedule: StopSchedule | null,
  nextSchedule: StopSchedule | null,
  delay: number,
  canonicalX: number,
  now: number,
  midnight: number,
  gpsTimestamp: number = now,
): SegmentPrediction {
  const scheduledNextArrivalEpoch = nextSchedule ? midnight + nextSchedule.arrivalSec : 0;
  const nextArrivalEpoch = scheduledNextArrivalEpoch ? scheduledNextArrivalEpoch + delay : 0;

  if (!nextSchedule) {
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch: 0, segmentSpeedKmh: null };
  }

  const segCxLen = Math.abs(nextStop.canonicalX - prevStop.canonicalX);
  if (segCxLen === 0) {
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch: 0, segmentSpeedKmh: null };
  }

  const distTraveled = Math.abs(canonicalX - prevStop.canonicalX);
  const fraction = Math.min(1, distTraveled / segCxLen);

  if (!prevSchedule) {
    const predictedNextArrivalEpoch = nextArrivalEpoch > gpsTimestamp
      ? nextArrivalEpoch
      : gpsTimestamp + Math.max(5, (1 - fraction) * 90);
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch, segmentSpeedKmh: null };
  }

  const segDurationSec = nextSchedule.arrivalSec - prevSchedule.departureSec;
  if (segDurationSec <= 0) {
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch: 0, segmentSpeedKmh: null };
  }

  const timeToNextSec = (1 - fraction) * segDurationSec;
  const predictedNextArrivalEpoch = gpsTimestamp + timeToNextSec;

  const distKm = haversineKm(prevStop.lat, prevStop.lon, nextStop.lat, nextStop.lon);
  const segmentSpeedKmh = distKm / (segDurationSec / 3600);

  return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch, segmentSpeedKmh };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
