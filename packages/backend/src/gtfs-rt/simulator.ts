/**
 * Pure simulation engine — no I/O, no Redis, no DB.
 * Replays stored LivePosition snapshots through our interpolation formula
 * and measures how well our predictions match reality.
 */

import type { LivePosition } from '@takemethere/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SimSnapshot {
  capturedAt: string;     // ISO — when we polled the API (distinct from GPS timestamp)
  vehicles: LivePosition[];
}

export interface IntervalResult {
  index: number;
  fromCapturedAt: string;
  toCapturedAt: string;
  intervalSec: number;

  // State at the START of the interval (what our engine had)
  fromCanonicalX: number;
  fromGpsTimestamp: number;
  fromGpsAgeSec: number;          // capturedAt_from - gpsTimestamp
  fromNextStopName: string | null;
  fromNextStopCanonicalX: number;
  fromPredArrivalEpoch: number;

  // What our engine predicted at toCapturedAt (using only from-state)
  predictedCanonicalX: number;

  // Ground truth at toCapturedAt
  actualCanonicalX: number;
  actualGpsTimestamp: number;
  actualGpsAgeSec: number;

  // Derived
  error: number;                  // predicted − actual  (+= ahead of actual)
  absError: number;
  gpsUpdated: boolean;            // PTV published a new GPS reading in this interval
  segmentChanged: boolean;        // prevStop or nextStop ID changed
  clampedAtStop: boolean;         // prediction was frozen at nextStopCanonicalX (t ≥ 1)
  largeActualJump: boolean;       // |actual_N − actual_{N−1}| > 0.05 (anomaly)
  isZombie: boolean;              // GPS was >180s stale at the FROM snapshot
}

export interface TripSimResult {
  tripId: string;
  lineId: string;
  firstCapturedAt: string;
  lastCapturedAt: string;
  presenceCount: number;          // snapshots in which this trip appeared
  intervals: IntervalResult[];

  // Aggregate accuracy
  mae: number;                    // mean absolute error (canonicalX)
  maxAbsError: number;
  bias: number;                   // mean signed error (+= engine runs ahead)
  accuracyPct: number;            // % intervals with |error| < 0.02

  // Breakdown counts
  freshIntervals: number;         // GPS updated during interval
  staleIntervals: number;         // GPS frozen during interval
  clampedCount: number;
  segmentChangedCount: number;
  largeJumpCount: number;
  zombieFromCount: number;
}

// ─── Core interpolation (mirrors streamer.computeInterpolatedX — kept inline
//     to avoid importing streamer.ts which pulls in Redis/publisher side effects) ──

function interpolateX(pos: LivePosition, nowSec: number): number {
  const arrivalEpoch = pos.predictedNextArrivalEpoch > 0
    ? pos.predictedNextArrivalEpoch
    : pos.nextArrivalEpoch;

  const hasNext =
    arrivalEpoch > pos.timestamp &&
    pos.nextStopCanonicalX >= 0 &&
    Math.abs(pos.nextStopCanonicalX - pos.canonicalX) > 0.002;

  if (!hasNext) return pos.canonicalX;

  const elapsed = nowSec - pos.timestamp;
  const total   = arrivalEpoch - pos.timestamp;
  if (total <= 0 || elapsed < 0) return pos.canonicalX;

  const t   = Math.min(1, elapsed / total);
  const raw = pos.canonicalX + t * (pos.nextStopCanonicalX - pos.canonicalX);
  const lo  = Math.min(pos.canonicalX, pos.nextStopCanonicalX);
  const hi  = Math.max(pos.canonicalX, pos.nextStopCanonicalX);
  return Math.max(lo, Math.min(hi, raw));
}

function isClampedAtStop(pos: LivePosition, predicted: number): boolean {
  if (pos.nextStopCanonicalX < 0) return false;
  return Math.abs(predicted - pos.nextStopCanonicalX) < 0.0001;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Run simulation for a single trip. Returns null if fewer than 2 snapshots found. */
export function simulateTrip(snapshots: SimSnapshot[], tripId: string): TripSimResult | null {
  // Collect records where this trip is present, in snapshot order
  const records: Array<{ capturedAtSec: number; capturedAt: string; pos: LivePosition }> = [];
  for (const snap of snapshots) {
    const pos = snap.vehicles.find(v => v.tripId === tripId);
    if (pos) records.push({ capturedAtSec: epochSec(snap.capturedAt), capturedAt: snap.capturedAt, pos });
  }
  if (records.length < 2) return null;

  const lineId = records[0].pos.lineId;
  const intervals: IntervalResult[] = [];

  for (let i = 0; i < records.length - 1; i++) {
    const from = records[i];
    const to   = records[i + 1];

    const intervalSec      = to.capturedAtSec - from.capturedAtSec;
    const fromGpsAgeSec    = from.capturedAtSec - from.pos.timestamp;
    const actualGpsAgeSec  = to.capturedAtSec - to.pos.timestamp;

    const predictedCanonicalX = interpolateX(from.pos, to.capturedAtSec);
    const actualCanonicalX    = to.pos.canonicalX;
    const error               = predictedCanonicalX - actualCanonicalX;

    const largeActualJump = i > 0
      ? Math.abs(actualCanonicalX - records[i].pos.canonicalX) > 0.05
      : false;

    intervals.push({
      index: i + 1,
      fromCapturedAt:        from.capturedAt,
      toCapturedAt:          to.capturedAt,
      intervalSec,
      fromCanonicalX:        from.pos.canonicalX,
      fromGpsTimestamp:      from.pos.timestamp,
      fromGpsAgeSec,
      fromNextStopName:      from.pos.nextStopName,
      fromNextStopCanonicalX: from.pos.nextStopCanonicalX,
      fromPredArrivalEpoch:  from.pos.predictedNextArrivalEpoch,
      predictedCanonicalX,
      actualCanonicalX,
      actualGpsTimestamp:    to.pos.timestamp,
      actualGpsAgeSec,
      error,
      absError:              Math.abs(error),
      gpsUpdated:            to.pos.timestamp !== from.pos.timestamp,
      segmentChanged:        to.pos.nextStopId !== from.pos.nextStopId || to.pos.prevStopId !== from.pos.prevStopId,
      clampedAtStop:         isClampedAtStop(from.pos, predictedCanonicalX),
      largeActualJump,
      isZombie:              fromGpsAgeSec > 180,
    });
  }

  const mae         = avg(intervals.map(r => r.absError));
  const maxAbsError = Math.max(...intervals.map(r => r.absError));
  const bias        = avg(intervals.map(r => r.error));
  const accuracyPct = (intervals.filter(r => r.absError < 0.02).length / intervals.length) * 100;

  return {
    tripId,
    lineId,
    firstCapturedAt: records[0].capturedAt,
    lastCapturedAt:  records[records.length - 1].capturedAt,
    presenceCount:   records.length,
    intervals,
    mae,
    maxAbsError,
    bias,
    accuracyPct,
    freshIntervals:       intervals.filter(r => r.gpsUpdated).length,
    staleIntervals:       intervals.filter(r => !r.gpsUpdated).length,
    clampedCount:         intervals.filter(r => r.clampedAtStop).length,
    segmentChangedCount:  intervals.filter(r => r.segmentChanged).length,
    largeJumpCount:       intervals.filter(r => r.largeActualJump).length,
    zombieFromCount:      intervals.filter(r => r.isZombie).length,
  };
}

/** List all trips present in the snapshots with presence counts. */
export function listTrips(snapshots: SimSnapshot[]): Array<{
  tripId: string; lineId: string; snapshotCount: number; firstSeen: string; lastSeen: string;
}> {
  const seen = new Map<string, { lineId: string; count: number; first: string; last: string }>();
  for (const snap of snapshots) {
    for (const v of snap.vehicles) {
      const e = seen.get(v.tripId);
      if (e) { e.count++; e.last = snap.capturedAt; }
      else seen.set(v.tripId, { lineId: v.lineId, count: 1, first: snap.capturedAt, last: snap.capturedAt });
    }
  }
  return Array.from(seen.entries())
    .map(([tripId, e]) => ({ tripId, lineId: e.lineId, snapshotCount: e.count, firstSeen: e.first, lastSeen: e.last }))
    .sort((a, b) => b.snapshotCount - a.snapshotCount || a.tripId.localeCompare(b.tripId));
}

/** Load snapshots from a JSONL string (one JSON object per line). */
export function parseSnapshots(jsonl: string): SimSnapshot[] {
  return jsonl
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as SimSnapshot);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function epochSec(iso: string): number {
  return new Date(iso).getTime() / 1000;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
