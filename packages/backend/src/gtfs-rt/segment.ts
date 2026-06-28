/**
 * Pure segment-detection and ETA-prediction functions.
 * Extracted for testability — no I/O, no side effects.
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
  arrivalSec: number;   // seconds from local midnight
  departureSec: number;
}

// ─── Segment detection ────────────────────────────────────────────────────────

export interface SegmentResult {
  prevStop: SegmentStop | null;
  nextStop: SegmentStop | null;
}

/**
 * Finds the stops immediately behind and ahead of a train's GPS canonical position.
 *
 * Outbound (forward=true): canonical X increases along the journey.
 *   - prevStop = last stop whose cx ≤ train position (just passed / at)
 *   - nextStop = first stop whose cx > train position (coming up)
 *
 * Inbound (forward=false): canonical X decreases along the journey.
 *   - prevStop = first stop whose cx ≥ train position (minimum cx ≥ pos = just passed)
 *   - nextStop = last stop  whose cx < train position (maximum cx < pos = coming up)
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
      if (s.canonicalX <= canonicalX) prevStop = s;      // keep overwriting → ends at last ≤ train
      else if (!nextStop) { nextStop = s; break; }        // first stop past train
    } else {
      // Iterating ascending cx: we want the highest cx that's still < train (→ nextStop)
      // and the first cx that's ≥ train (→ prevStop, minimum such cx).
      if (s.canonicalX < canonicalX) nextStop = s;        // keep overwriting → ends at highest < train
      else if (!prevStop) { prevStop = s; break; }        // minimum cx ≥ train
    }
  }

  return { prevStop, nextStop };
}

// ─── ETA / speed prediction ───────────────────────────────────────────────────

export interface SegmentPrediction {
  scheduledNextArrivalEpoch: number;   // midnight + nextSchedule.arrivalSec (no delay)
  nextArrivalEpoch: number;            // scheduledNextArrivalEpoch + delay
  predictedNextArrivalEpoch: number;   // GPS-position interpolation; 0 if unknown
  segmentSpeedKmh: number | null;      // straight-line haversine / scheduled duration
}

/**
 * `gpsTimestamp` is the epoch when the vehicle's GPS position was captured —
 * distinct from `now` (publish time) which may be 30–60s later.
 *
 * Anchoring predictedNextArrivalEpoch to gpsTimestamp is critical:
 *   total = predictedNextArrivalEpoch - pos.timestamp = timeToNextSec
 *   elapsed = streamTime - gpsTimestamp  (grows correctly from the moment of capture)
 *   t = elapsed / total
 *
 * If we used `now` instead, total would be inflated by the GPS lag (~40s), making
 * the train appear to move much more slowly than it actually is.
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
    // prevStop not in this trip's stop_times (express skip or platform ID mismatch).
    // Anchor to gpsTimestamp so the streamer's elapsed/total calculation is correct.
    const predictedNextArrivalEpoch = nextArrivalEpoch > gpsTimestamp
      ? nextArrivalEpoch
      : gpsTimestamp + Math.max(5, (1 - fraction) * 90);
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch, segmentSpeedKmh: null };
  }

  const segDurationSec = nextSchedule.arrivalSec - prevSchedule.departureSec;
  if (segDurationSec <= 0) {
    return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch: 0, segmentSpeedKmh: null };
  }

  // timeToNextSec: remaining time from the GPS capture point.
  // Anchored to gpsTimestamp so elapsed/total in the streamer is exact.
  const timeToNextSec = (1 - fraction) * segDurationSec;
  const predictedNextArrivalEpoch = gpsTimestamp + timeToNextSec;

  const distKm = haversineKm(prevStop.lat, prevStop.lon, nextStop.lat, nextStop.lon);
  const segmentSpeedKmh = distKm / (segDurationSec / 3600);

  return { scheduledNextArrivalEpoch, nextArrivalEpoch, predictedNextArrivalEpoch, segmentSpeedKmh };
}

// ─── TU-derived segment detection ────────────────────────────────────────────

/**
 * Resolves prevStop/nextStop using the Trip Update's authoritative next-stop ID.
 * Preferred over GPS-derived detection because GPS can be noisy near stops/terminus.
 *
 * prevStop = the stop immediately before nextStop in the journey direction:
 *   outbound (forward): lower index in cx-ascending array → lower cx
 *   inbound (!forward): higher index in cx-ascending array → higher cx
 *
 * Returns { null, null } if tuNextStopId is not found in the stop list.
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
