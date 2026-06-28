import { describe, it, expect } from 'vitest';
import {
  findSegmentStops,
  findSegmentFromTU,
  computeSegmentPrediction,
  haversineKm,
  type SegmentStop,
  type StopSchedule,
} from '../../../src/stream/engine/position_enricher.js';

const STOPS: SegmentStop[] = [
  { stopId: 'A', canonicalX: 0.0,  lat: -37.8183, lon: 144.9671, stopName: 'Flinders Street' },
  { stopId: 'B', canonicalX: 0.25, lat: -37.8300, lon: 145.0200, stopName: 'Burnley' },
  { stopId: 'C', canonicalX: 0.50, lat: -37.8450, lon: 145.0600, stopName: 'Camberwell' },
  { stopId: 'D', canonicalX: 0.75, lat: -37.8600, lon: 145.0900, stopName: 'Jordanville' },
  { stopId: 'E', canonicalX: 1.0,  lat: -37.8750, lon: 145.1700, stopName: 'Glen Waverley' },
];

const SCHEDULES: Record<string, StopSchedule> = {
  A: { stopId: 'A', arrivalSec: 7 * 3600,           departureSec: 7 * 3600 },
  B: { stopId: 'B', arrivalSec: 7 * 3600 + 10 * 60, departureSec: 7 * 3600 + 10 * 60 },
  C: { stopId: 'C', arrivalSec: 7 * 3600 + 20 * 60, departureSec: 7 * 3600 + 20 * 60 },
  D: { stopId: 'D', arrivalSec: 7 * 3600 + 30 * 60, departureSec: 7 * 3600 + 30 * 60 },
  E: { stopId: 'E', arrivalSec: 7 * 3600 + 40 * 60, departureSec: 7 * 3600 + 40 * 60 },
};

const MIDNIGHT = 1_700_000_000;
const NOW      = MIDNIGHT + 7 * 3600 + 15 * 60;

describe('findSegmentStops — outbound', () => {
  it('train between B and C', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 0.35, true);
    expect(prevStop?.stopId).toBe('B');
    expect(nextStop?.stopId).toBe('C');
  });

  it('train exactly at a stop snaps to that stop as prev', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 0.50, true);
    expect(prevStop?.stopId).toBe('C');
    expect(nextStop?.stopId).toBe('D');
  });

  it('train before first stop has no prev', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, -0.01, true);
    expect(prevStop).toBeNull();
    expect(nextStop?.stopId).toBe('A');
  });

  it('train past final stop has no next', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 1.1, true);
    expect(prevStop?.stopId).toBe('E');
    expect(nextStop).toBeNull();
  });
});

describe('findSegmentStops — inbound', () => {
  it('train between D and C (inbound at cx=0.65)', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 0.65, false);
    expect(prevStop?.stopId).toBe('D');
    expect(nextStop?.stopId).toBe('C');
  });

  it('train exactly at D inbound snaps D as prev', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 0.75, false);
    expect(prevStop?.stopId).toBe('D');
    expect(nextStop?.stopId).toBe('C');
  });

  it('train between B and A inbound', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, 0.1, false);
    expect(prevStop?.stopId).toBe('B');
    expect(nextStop?.stopId).toBe('A');
  });

  it('inbound train past terminus (cx below 0) has prevStop=first stop, no next', () => {
    const { prevStop, nextStop } = findSegmentStops(STOPS, -0.05, false);
    expect(prevStop?.stopId).toBe('A');
    expect(nextStop).toBeNull();
  });
});

describe('findSegmentFromTU — outbound', () => {
  it('TU next=C → prevStop=B, nextStop=C', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'C', true);
    expect(prevStop?.stopId).toBe('B');
    expect(nextStop?.stopId).toBe('C');
  });

  it('TU next=A (first stop) → prevStop=null, nextStop=A', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'A', true);
    expect(prevStop).toBeNull();
    expect(nextStop?.stopId).toBe('A');
  });

  it('TU next=E (terminus) → prevStop=D, nextStop=E', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'E', true);
    expect(prevStop?.stopId).toBe('D');
    expect(nextStop?.stopId).toBe('E');
  });
});

describe('findSegmentFromTU — inbound', () => {
  it('TU next=C → prevStop=D (higher cx), nextStop=C', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'C', false);
    expect(prevStop?.stopId).toBe('D');
    expect(nextStop?.stopId).toBe('C');
  });

  it('TU next=A (inbound terminus) → prevStop=B, nextStop=A', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'A', false);
    expect(prevStop?.stopId).toBe('B');
    expect(nextStop?.stopId).toBe('A');
  });

  it('TU next=E (inbound first stop) → prevStop=null (nothing beyond E)', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'E', false);
    expect(prevStop).toBeNull();
    expect(nextStop?.stopId).toBe('E');
  });
});

describe('findSegmentFromTU — unknown stopId', () => {
  it('returns null/null for unrecognised stop ID', () => {
    const { prevStop, nextStop } = findSegmentFromTU(STOPS, 'Z', true);
    expect(prevStop).toBeNull();
    expect(nextStop).toBeNull();
  });
});

describe('computeSegmentPrediction', () => {
  const prevStop = STOPS[1];
  const nextStop = STOPS[2];
  const prevSch  = SCHEDULES['B'];
  const nextSch  = SCHEDULES['C'];

  it('train at segment start (cx=0.25) → ~600s to next', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.25, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBeCloseTo(NOW + 600, 0);
  });

  it('train at segment midpoint (cx=0.375) → ~300s to next', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.375, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBeCloseTo(NOW + 300, 0);
  });

  it('train at segment end (cx=0.50) → ~0s to next', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.50, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBeCloseTo(NOW, 1);
  });

  it('scheduledNextArrivalEpoch is midnight + arrivalSec', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.35, NOW, MIDNIGHT);
    expect(res.scheduledNextArrivalEpoch).toBe(MIDNIGHT + nextSch.arrivalSec);
  });

  it('nextArrivalEpoch applies delay', () => {
    const delay = 120;
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, delay, 0.35, NOW, MIDNIGHT);
    expect(res.nextArrivalEpoch).toBe(MIDNIGHT + nextSch.arrivalSec + delay);
  });

  it('segmentSpeedKmh is positive and plausible for a train', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.35, NOW, MIDNIGHT);
    expect(res.segmentSpeedKmh).not.toBeNull();
    expect(res.segmentSpeedKmh!).toBeGreaterThan(10);
    expect(res.segmentSpeedKmh!).toBeLessThan(120);
  });

  it('returns zeros when nextSchedule is unavailable', () => {
    const res = computeSegmentPrediction(prevStop, nextStop, null, null, 0, 0.35, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBe(0);
    expect(res.scheduledNextArrivalEpoch).toBe(0);
    expect(res.segmentSpeedKmh).toBeNull();
  });

  it('null prevSchedule + future nextArrivalEpoch → uses nextArrivalEpoch as prediction', () => {
    const futureNextSch: StopSchedule = { stopId: 'C', arrivalSec: 7 * 3600 + 20 * 60, departureSec: 7 * 3600 + 20 * 60 };
    const res = computeSegmentPrediction(prevStop, nextStop, null, futureNextSch, 0, 0.35, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBe(MIDNIGHT + futureNextSch.arrivalSec);
    expect(res.segmentSpeedKmh).toBeNull();
  });

  it('null prevSchedule + past nextArrivalEpoch (late train) → GPS-derived fallback prediction', () => {
    const pastNextSch: StopSchedule = { stopId: 'C', arrivalSec: 7 * 3600 + 10 * 60, departureSec: 7 * 3600 + 10 * 60 };
    const res = computeSegmentPrediction(prevStop, nextStop, null, pastNextSch, 0, 0.375, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBeGreaterThan(NOW);
    expect(res.predictedNextArrivalEpoch).toBeLessThan(NOW + 90);
    expect(res.segmentSpeedKmh).toBeNull();
  });

  it('GPS snapshot age: predictedNextArrivalEpoch anchored to gpsTimestamp, not publishTime', () => {
    const GPS_TS = NOW - 40;
    const res = computeSegmentPrediction(prevStop, nextStop, prevSch, nextSch, 0, 0.375, NOW, MIDNIGHT, GPS_TS);
    expect(res.predictedNextArrivalEpoch).toBeCloseTo(GPS_TS + 300, 0);
    expect(Math.abs(res.predictedNextArrivalEpoch - (NOW + 300))).toBeGreaterThan(30);
  });

  it('inbound: train between D(0.75) and C(0.50) at cx=0.65', () => {
    const INBOUND_SCH: Record<string, StopSchedule> = {
      D: { stopId: 'D', arrivalSec: 7 * 3600 + 10 * 60, departureSec: 7 * 3600 + 10 * 60 },
      C: { stopId: 'C', arrivalSec: 7 * 3600 + 20 * 60, departureSec: 7 * 3600 + 20 * 60 },
    };
    const inboundPrev = STOPS[3];
    const inboundNext = STOPS[2];
    const res = computeSegmentPrediction(inboundPrev, inboundNext, INBOUND_SCH['D'], INBOUND_SCH['C'], 0, 0.65, NOW, MIDNIGHT);
    expect(res.predictedNextArrivalEpoch).toBeCloseTo(NOW + 360, 0);
  });
});

describe('haversineKm', () => {
  it('same point = 0', () => {
    expect(haversineKm(-37.82, 144.97, -37.82, 144.97)).toBeCloseTo(0, 5);
  });

  it('Flinders St to Burnley is roughly 2-5 km', () => {
    const dist = haversineKm(
      STOPS[0].lat, STOPS[0].lon,
      STOPS[1].lat, STOPS[1].lon,
    );
    expect(dist).toBeGreaterThan(1);
    expect(dist).toBeLessThan(10);
  });
});
