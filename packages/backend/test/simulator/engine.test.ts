import { describe, it, expect } from 'vitest';
import { simulateTrip, listTrips, parseSnapshots, type SimSnapshot } from '../../src/simulator/engine.js';
import type { LivePosition } from '@takemethere/shared';

function makePos(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId: 'trip-1',
    lineId: 'belgrave',
    lat: -37.82, lon: 145.0,
    bearing: 90,
    timestamp: 1_000_000,
    canonicalX: 0.3,
    prevStopId: 'p1', prevStopName: 'Richmond', prevStopCanonicalX: 0.2,
    nextStopId: 'n1', nextStopName: 'Camberwell', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 1_000_200,
    nextArrivalEpoch: 1_000_200,
    predictedNextArrivalEpoch: 1_000_200,
    delay: 0,
    segmentSpeedKmh: 80,
    directionId: 0,
    upcomingStops: [],
    ...overrides,
  };
}

function makeSnapshot(capturedAt: string, vehicles: LivePosition[]): SimSnapshot {
  return { capturedAt, vehicles };
}

const BASE_EPOCH = 1_000_000;
const PRED_EPOCH = 1_000_200;

function isoAt(offsetSec: number): string {
  return new Date((BASE_EPOCH + offsetSec) * 1000).toISOString();
}

describe('parseSnapshots', () => {
  it('parses a valid JSONL string', () => {
    const snap = { capturedAt: '2026-01-01T00:00:00Z', vehicles: [] };
    const result = parseSnapshots(JSON.stringify(snap));
    expect(result).toHaveLength(1);
    expect(result[0].capturedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('skips blank lines', () => {
    const line = JSON.stringify({ capturedAt: '2026-01-01T00:00:00Z', vehicles: [] });
    const result = parseSnapshots(`${line}\n\n${line}\n`);
    expect(result).toHaveLength(2);
  });
});

describe('listTrips', () => {
  it('lists trips sorted by snapshot count descending', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot('2026-01-01T00:00:00Z', [makePos({ tripId: 'a' }), makePos({ tripId: 'b' })]),
      makeSnapshot('2026-01-01T00:00:30Z', [makePos({ tripId: 'a' })]),
    ];
    const trips = listTrips(snaps);
    expect(trips[0].tripId).toBe('a');
    expect(trips[0].snapshotCount).toBe(2);
    expect(trips[1].tripId).toBe('b');
    expect(trips[1].snapshotCount).toBe(1);
  });

  it('records firstSeen and lastSeen correctly', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot('2026-01-01T00:00:00Z', [makePos({ tripId: 'a' })]),
      makeSnapshot('2026-01-01T00:00:30Z', [makePos({ tripId: 'a' })]),
    ];
    const [trip] = listTrips(snaps);
    expect(trip.firstSeen).toBe('2026-01-01T00:00:00Z');
    expect(trip.lastSeen).toBe('2026-01-01T00:00:30Z');
  });
});

describe('simulateTrip', () => {
  it('returns null when trip appears in fewer than 2 snapshots', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos({ tripId: 'trip-1' })]),
      makeSnapshot(isoAt(130), [makePos({ tripId: 'other' })]),
    ];
    expect(simulateTrip(snaps, 'trip-1')).toBeNull();
  });

  it('returns null for an unknown tripId', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos()]),
      makeSnapshot(isoAt(130), [makePos()]),
    ];
    expect(simulateTrip(snaps, 'nonexistent')).toBeNull();
  });

  it('produces one interval for two snapshots', () => {
    const pos = makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH });
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [pos]),
      makeSnapshot(isoAt(130), [makePos({ canonicalX: 0.35, timestamp: BASE_EPOCH + 30 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result).not.toBeNull();
    expect(result.intervals).toHaveLength(1);
  });

  it('computes predicted canonicalX via interpolation formula', () => {
    // elapsed = (BASE_EPOCH+130) - BASE_EPOCH = 130s; total = 200s; t = 0.65
    // interpX = 0.3 + 0.65 * (0.5 - 0.3) = 0.43
    const pos = makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH });
    const actual = makePos({ canonicalX: 0.35, timestamp: BASE_EPOCH + 30 });
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [pos]),
      makeSnapshot(isoAt(130), [actual]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    const [iv] = result.intervals;
    expect(iv.predictedCanonicalX).toBeCloseTo(0.43, 4);
    expect(iv.actualCanonicalX).toBe(0.35);
    expect(iv.error).toBeCloseTo(0.08, 4);
    expect(iv.absError).toBeCloseTo(0.08, 4);
  });

  it('clamps prediction at nextStopCanonicalX when elapsed > total (t=1)', () => {
    const pos = makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH });
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0), [pos]),
      makeSnapshot(isoAt(250), [makePos({ canonicalX: 0.48 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    const [iv] = result.intervals;
    expect(iv.predictedCanonicalX).toBeCloseTo(0.5, 4);
    expect(iv.clampedAtStop).toBe(true);
  });

  it('freezes at canonicalX when predictedNextArrivalEpoch is 0', () => {
    const pos = makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: 0, nextArrivalEpoch: 0 });
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [pos]),
      makeSnapshot(isoAt(130), [makePos({ canonicalX: 0.4 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    const [iv] = result.intervals;
    expect(iv.predictedCanonicalX).toBe(0.3);
  });

  it('detects GPS updated (gpsUpdated=true) when timestamp changes', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos({ timestamp: BASE_EPOCH })]),
      makeSnapshot(isoAt(130), [makePos({ timestamp: BASE_EPOCH + 30 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].gpsUpdated).toBe(true);
  });

  it('detects frozen GPS (gpsUpdated=false) when timestamp unchanged', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos({ timestamp: BASE_EPOCH })]),
      makeSnapshot(isoAt(130), [makePos({ timestamp: BASE_EPOCH })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].gpsUpdated).toBe(false);
  });

  it('detects segment change when nextStopId changes', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos({ nextStopId: 'n1' })]),
      makeSnapshot(isoAt(130), [makePos({ nextStopId: 'n2' })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].segmentChanged).toBe(true);
  });

  it('marks isZombie=true when GPS age at FROM snapshot exceeds 180s', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(200), [makePos({ timestamp: BASE_EPOCH })]),
      makeSnapshot(isoAt(230), [makePos({ timestamp: BASE_EPOCH })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].isZombie).toBe(true);
  });

  it('marks largeActualJump=true when actual moves >0.05 between snapshots', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(100), [makePos({ canonicalX: 0.3 })]),
      makeSnapshot(isoAt(130), [makePos({ canonicalX: 0.4 })]),
      makeSnapshot(isoAt(160), [makePos({ canonicalX: 0.51 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].largeActualJump).toBe(false);
    expect(result.intervals[1].largeActualJump).toBe(true);
  });

  it('computes correct aggregate stats', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0), [makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH })]),
      makeSnapshot(isoAt(50), [makePos({ canonicalX: 0.33, timestamp: BASE_EPOCH + 30 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.mae).toBeCloseTo(result.intervals.reduce((s, r) => s + r.absError, 0) / result.intervals.length, 6);
    expect(result.maxAbsError).toBe(Math.max(...result.intervals.map(r => r.absError)));
    expect(result.accuracyPct).toBeGreaterThanOrEqual(0);
    expect(result.accuracyPct).toBeLessThanOrEqual(100);
  });

  it('counts fresh and stale intervals correctly', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0),  [makePos({ timestamp: BASE_EPOCH })]),
      makeSnapshot(isoAt(30), [makePos({ timestamp: BASE_EPOCH + 30 })]),
      makeSnapshot(isoAt(60), [makePos({ timestamp: BASE_EPOCH + 30 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.freshIntervals).toBe(1);
    expect(result.staleIntervals).toBe(1);
  });

  it('handles a trip that is absent from some snapshots (gaps)', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0),  [makePos({ tripId: 'trip-1' })]),
      makeSnapshot(isoAt(30), []),
      makeSnapshot(isoAt(60), [makePos({ tripId: 'trip-1', canonicalX: 0.4 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.presenceCount).toBe(2);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].intervalSec).toBeCloseTo(60, 1);
  });
});
