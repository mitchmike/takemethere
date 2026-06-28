/**
 * Simulation engine — replays stored LivePosition snapshots through a PositionEngine
 * and measures prediction accuracy against ground-truth GPS readings.
 */

import type { LivePosition } from '@takemethere/shared';
import type { PositionEngine } from '../stream/engine/types.js';
import { linearEngine } from '../stream/engine/linear_interp.js';

export interface SimSnapshot {
  capturedAt: string;     // ISO — when we polled the API (distinct from GPS timestamp)
  vehicles: LivePosition[];
}

export interface IntervalResult {
  index: number;
  fromCapturedAt: string;
  toCapturedAt: string;
  intervalSec: number;

  fromCanonicalX: number;
  fromGpsTimestamp: number;
  fromGpsAgeSec: number;
  fromNextStopName: string | null;
  fromNextStopCanonicalX: number;
  fromPredArrivalEpoch: number;

  predictedCanonicalX: number;
  actualCanonicalX: number;
  actualGpsTimestamp: number;
  actualGpsAgeSec: number;

  error: number;
  absError: number;
  gpsUpdated: boolean;
  segmentChanged: boolean;
  clampedAtStop: boolean;
  largeActualJump: boolean;
  isZombie: boolean;
}

export interface TripSimResult {
  tripId: string;
  lineId: string;
  firstCapturedAt: string;
  lastCapturedAt: string;
  presenceCount: number;
  intervals: IntervalResult[];

  mae: number;
  maxAbsError: number;
  bias: number;
  accuracyPct: number;

  freshIntervals: number;
  staleIntervals: number;
  clampedCount: number;
  segmentChangedCount: number;
  largeJumpCount: number;
  zombieFromCount: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function simulateTrip(
  snapshots: SimSnapshot[],
  tripId: string,
  engine: PositionEngine = linearEngine,
): TripSimResult | null {
  const records: Array<{ capturedAtSec: number; capturedAt: string; pos: LivePosition }> = [];
  for (const snap of snapshots) {
    const pos = snap.vehicles.find(v => v.tripId === tripId);
    if (pos) records.push({ capturedAtSec: epochSec(snap.capturedAt), capturedAt: snap.capturedAt, pos });
  }
  if (records.length < 2) return null;

  const lineId    = records[0].pos.lineId;
  const intervals: IntervalResult[] = [];

  for (let i = 0; i < records.length - 1; i++) {
    const from = records[i];
    const to   = records[i + 1];

    const intervalSec     = to.capturedAtSec - from.capturedAtSec;
    const fromGpsAgeSec   = from.capturedAtSec - from.pos.timestamp;
    const actualGpsAgeSec = to.capturedAtSec - to.pos.timestamp;

    const predictedCanonicalX = engine.interpolate(from.pos, to.capturedAtSec);
    const actualCanonicalX    = to.pos.canonicalX;
    const error               = predictedCanonicalX - actualCanonicalX;

    const largeActualJump = i > 0
      ? Math.abs(actualCanonicalX - records[i].pos.canonicalX) > 0.05
      : false;

    intervals.push({
      index: i + 1,
      fromCapturedAt:         from.capturedAt,
      toCapturedAt:           to.capturedAt,
      intervalSec,
      fromCanonicalX:         from.pos.canonicalX,
      fromGpsTimestamp:       from.pos.timestamp,
      fromGpsAgeSec,
      fromNextStopName:       from.pos.nextStopName,
      fromNextStopCanonicalX: from.pos.nextStopCanonicalX,
      fromPredArrivalEpoch:   from.pos.predictedNextArrivalEpoch,
      predictedCanonicalX,
      actualCanonicalX,
      actualGpsTimestamp:     to.pos.timestamp,
      actualGpsAgeSec,
      error,
      absError:               Math.abs(error),
      gpsUpdated:             to.pos.timestamp !== from.pos.timestamp,
      segmentChanged:         to.pos.nextStopId !== from.pos.nextStopId || to.pos.prevStopId !== from.pos.prevStopId,
      clampedAtStop:          isClampedAtStop(from.pos, predictedCanonicalX),
      largeActualJump,
      isZombie:               fromGpsAgeSec > 180,
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
    mae, maxAbsError, bias, accuracyPct,
    freshIntervals:      intervals.filter(r => r.gpsUpdated).length,
    staleIntervals:      intervals.filter(r => !r.gpsUpdated).length,
    clampedCount:        intervals.filter(r => r.clampedAtStop).length,
    segmentChangedCount: intervals.filter(r => r.segmentChanged).length,
    largeJumpCount:      intervals.filter(r => r.largeActualJump).length,
    zombieFromCount:     intervals.filter(r => r.isZombie).length,
  };
}

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

export function parseSnapshots(jsonl: string): SimSnapshot[] {
  return jsonl.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as SimSnapshot);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isClampedAtStop(pos: LivePosition, predicted: number): boolean {
  if (pos.nextStopCanonicalX < 0) return false;
  return Math.abs(predicted - pos.nextStopCanonicalX) < 0.0001;
}

function epochSec(iso: string): number { return new Date(iso).getTime() / 1000; }
function avg(nums: number[]): number { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
