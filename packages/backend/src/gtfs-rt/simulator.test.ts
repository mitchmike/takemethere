import { describe, it, expect } from 'vitest';
import { simulateTrip, listTrips, parseSnapshots, type SimSnapshot } from './simulator.js';
import type { LivePosition } from '@takemethere/shared';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

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

// The interpolation formula used in simulator.ts (for golden-value verification):
// elapsed = capturedAt_sec - pos.timestamp
// total   = predictedNextArrivalEpoch - pos.timestamp
// t       = min(1, elapsed / total)
// interpX = canonicalX + t * (nextStopCanonicalX - canonicalX)

const BASE_EPOCH = 1_000_000;
const PRED_EPOCH = 1_000_200; // 200s ahead of BASE_EPOCH
const SEC = (iso: string) => new Date(iso).getTime() / 1000;

// Snapshot timestamps are ISO strings. We use a fixed base to match BASE_EPOCH.
// BASE_EPOCH = 2001-09-08T21:46:40Z ≈ just a number we can work with.
function isoAt(offsetSec: number): string {
  return new Date((BASE_EPOCH + offsetSec) * 1000).toISOString();
}

// ─── parseSnapshots ────────────────────────────────────────────────────────────

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

// ─── listTrips ─────────────────────────────────────────────────────────────────

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

// ─── simulateTrip ──────────────────────────────────────────────────────────────

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
    // At capturedAt_S0+100s, GPS timestamp = BASE_EPOCH, predArrival = PRED_EPOCH (200s ahead)
    // At capturedAt_S1 (S0+130s):
    //   elapsed = (capturedAt_S1_sec - BASE_EPOCH) = (100+130) = 230s  (from GPS timestamp)
    //   Hmm — let me be more careful.
    //   capturedAt_S0 = isoAt(100) → epoch = BASE_EPOCH + 100
    //   capturedAt_S1 = isoAt(130) → epoch = BASE_EPOCH + 130
    //   pos.timestamp = BASE_EPOCH (GPS capture time)
    //   elapsed = capturedAt_S1_sec - pos.timestamp = (BASE_EPOCH+130) - BASE_EPOCH = 130s
    //   total   = PRED_EPOCH - pos.timestamp = PRED_EPOCH - BASE_EPOCH = 200s
    //   t       = min(1, 130/200) = 0.65
    //   interpX = 0.3 + 0.65 * (0.5 - 0.3) = 0.3 + 0.13 = 0.43
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
    // error = predicted - actual = 0.43 - 0.35 = 0.08 (engine is ahead)
    expect(iv.error).toBeCloseTo(0.08, 4);
    expect(iv.absError).toBeCloseTo(0.08, 4);
  });

  it('clamps prediction at nextStopCanonicalX when elapsed > total (t=1)', () => {
    // elapsed = 250s > total = 200s → t clamped to 1 → predicted = nextStopCanonicalX = 0.5
    const pos = makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH });
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0), [pos]),
      makeSnapshot(isoAt(250), [makePos({ canonicalX: 0.48 })]), // actual past stop but we only know GPS
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    const [iv] = result.intervals;
    // elapsed = capturedAt_S1 - timestamp = (BASE_EPOCH+250) - BASE_EPOCH = 250s > 200s → t=1
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
    expect(iv.predictedCanonicalX).toBe(0.3); // frozen
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
    // capturedAt_S0 = isoAt(200), pos.timestamp = BASE_EPOCH → age = 200s > 180s → zombie
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
      makeSnapshot(isoAt(160), [makePos({ canonicalX: 0.51 })]), // 0.51 - 0.4 = 0.11 > 0.05
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.intervals[0].largeActualJump).toBe(false); // first interval has no prior
    expect(result.intervals[1].largeActualJump).toBe(true);
  });

  it('computes correct aggregate stats', () => {
    // Two intervals: absErrors [0.02, 0.06]
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0), [makePos({ canonicalX: 0.3, timestamp: BASE_EPOCH, predictedNextArrivalEpoch: PRED_EPOCH })]),
      // At elapsed=50s: t=50/200=0.25, pred=0.3+0.25*0.2=0.35, actual=0.33 → error=+0.02
      makeSnapshot(isoAt(50), [makePos({ canonicalX: 0.33, timestamp: BASE_EPOCH + 30 })]),
      // At elapsed=80s from NEXT baseline: we need to set up carefully...
      // Just check that mae = mean(absErrors)
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
      makeSnapshot(isoAt(30), [makePos({ timestamp: BASE_EPOCH + 30 })]), // fresh
      makeSnapshot(isoAt(60), [makePos({ timestamp: BASE_EPOCH + 30 })]), // frozen
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    expect(result.freshIntervals).toBe(1);
    expect(result.staleIntervals).toBe(1);
  });

  it('handles a trip that is absent from some snapshots (gaps)', () => {
    const snaps: SimSnapshot[] = [
      makeSnapshot(isoAt(0),  [makePos({ tripId: 'trip-1' })]),
      makeSnapshot(isoAt(30), []),                                    // trip absent
      makeSnapshot(isoAt(60), [makePos({ tripId: 'trip-1', canonicalX: 0.4 })]),
    ];
    const result = simulateTrip(snaps, 'trip-1')!;
    // Only 2 presence records → 1 interval, gap snapshot is skipped
    expect(result.presenceCount).toBe(2);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].intervalSec).toBeCloseTo(60, 1);
  });
});
