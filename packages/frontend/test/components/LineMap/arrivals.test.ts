import { describe, it, expect } from 'vitest';
import { getArrivalsForStop } from '../../../src/components/LineMap/arrivals.js';
import type { LivePosition } from '@takemethere/shared';

const NOW = 1_700_000_000;

function makePos(overrides: Partial<LivePosition> & { tripId: string }): LivePosition {
  return {
    lineId: 'belgrave', lat: -37.85, lon: 145.1, bearing: 90,
    timestamp: NOW - 10, canonicalX: 0.3, delay: 0, directionId: 0,
    prevStopId: '1', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
    nextStopId: '2', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 0, nextArrivalEpoch: 0, predictedNextArrivalEpoch: 0,
    segmentSpeedKmh: null, upcomingStops: [],
    ...overrides,
  };
}

function makeUpcomingStop(stopId: string, stopName: string, adjustedArrivalEpoch: number, predictedArrivalEpoch = 0) {
  return { stopId, stopName, canonicalX: 0.5, scheduledArrivalEpoch: adjustedArrivalEpoch, adjustedArrivalEpoch, predictedArrivalEpoch, tuDelaySeconds: null };
}

describe('getArrivalsForStop', () => {
  it('returns arrivals for matching stopId', () => {
    const pos = makePos({
      tripId: 't1',
      upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)],
    });
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result).toHaveLength(1);
    expect(result[0].tripId).toBe('t1');
  });

  it('matches by normalised stop name when stopId differs', () => {
    const pos = makePos({
      tripId: 't1',
      upcomingStops: [makeUpcomingStop('ALT-999', 'Camberwell Station', NOW + 60)],
    });
    // Query by a different stopId but same name
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result).toHaveLength(1);
  });

  it('excludes past arrivals', () => {
    const pos = makePos({
      tripId: 't1',
      upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW - 30)],
    });
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result).toHaveLength(0);
  });

  it('excludes trains on a different line', () => {
    const pos = makePos({
      tripId: 't1', lineId: 'frankston',
      upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)],
    });
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result).toHaveLength(0);
  });

  it('caps results at 3 per stop', () => {
    const positions = new Map<string, LivePosition>();
    for (let i = 0; i < 5; i++) {
      const pos = makePos({
        tripId: `t${i}`,
        upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60 + i * 60)],
      });
      positions.set(`t${i}`, pos);
    }
    const result = getArrivalsForStop('S1', 'Camberwell Station', positions, 'belgrave', 'both', NOW);
    expect(result).toHaveLength(3);
  });

  it('sorts results by adjustedArrivalEpoch ascending', () => {
    const positions = new Map<string, LivePosition>([
      ['t1', makePos({ tripId: 't1', upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 120)] })],
      ['t2', makePos({ tripId: 't2', upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)] })],
    ]);
    const result = getArrivalsForStop('S1', 'Camberwell Station', positions, 'belgrave', 'both', NOW);
    expect(result[0].tripId).toBe('t2');
    expect(result[1].tripId).toBe('t1');
  });

  it('filters out inbound trains when directionFilter is outbound', () => {
    const positions = new Map<string, LivePosition>([
      ['out', makePos({ tripId: 'out', directionId: 0, upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)] })],
      ['in',  makePos({ tripId: 'in',  directionId: 1, upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 90)] })],
    ]);
    const result = getArrivalsForStop('S1', 'Camberwell Station', positions, 'belgrave', 'outbound', NOW);
    expect(result).toHaveLength(1);
    expect(result[0].tripId).toBe('out');
  });

  it('filters out outbound trains when directionFilter is inbound', () => {
    const positions = new Map<string, LivePosition>([
      ['out', makePos({ tripId: 'out', directionId: 0, upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)] })],
      ['in',  makePos({ tripId: 'in',  directionId: 1, upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 90)] })],
    ]);
    const result = getArrivalsForStop('S1', 'Camberwell Station', positions, 'belgrave', 'inbound', NOW);
    expect(result).toHaveLength(1);
    expect(result[0].tripId).toBe('in');
  });

  it('returns an empty array when no trains have upcoming stops at this stop', () => {
    const pos = makePos({ tripId: 't1', upcomingStops: [] });
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result).toHaveLength(0);
  });

  describe('priorityTripId — include selected train regardless of lineId mismatch', () => {
    it('includes priority trip even when its lineId differs from the strip lineId', () => {
      const pos = makePos({
        tripId: 'sel', lineId: 'backend-alamein-42', // differs from strip lineId 'belgrave'
        upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)],
      });
      const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['sel', pos]]), 'belgrave', 'both', NOW, 'sel');
      expect(result).toHaveLength(1);
      expect(result[0].tripId).toBe('sel');
    });

    it('does not duplicate if priority trip already matched by lineId', () => {
      const pos = makePos({
        tripId: 'sel', lineId: 'belgrave',
        upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)],
      });
      const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['sel', pos]]), 'belgrave', 'both', NOW, 'sel');
      expect(result).toHaveLength(1);
    });

    it('respects directionFilter for priority trip', () => {
      const pos = makePos({
        tripId: 'sel', lineId: 'other', directionId: 1, // inbound
        upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60)],
      });
      const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['sel', pos]]), 'belgrave', 'outbound', NOW, 'sel');
      expect(result).toHaveLength(0);
    });

    it('does not include priority trip when upcoming stop is in the past', () => {
      const pos = makePos({
        tripId: 'sel', lineId: 'other',
        upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW - 30)],
      });
      const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['sel', pos]]), 'belgrave', 'both', NOW, 'sel');
      expect(result).toHaveLength(0);
    });
  });

  it('includes predictedArrivalEpoch in results', () => {
    const pos = makePos({
      tripId: 't1',
      upcomingStops: [makeUpcomingStop('S1', 'Camberwell Station', NOW + 60, NOW + 75)],
    });
    const result = getArrivalsForStop('S1', 'Camberwell Station', new Map([['t1', pos]]), 'belgrave', 'both', NOW);
    expect(result[0].predictedArrivalEpoch).toBe(NOW + 75);
  });
});
