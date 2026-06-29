import { describe, it, expect, beforeEach } from 'vitest';
import { useTrainsStore } from '../../src/store/trainsStore.js';
import type { LivePosition, StreamedPosition } from '@takemethere/shared';

function makePos(tripId: string, overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    tripId, lineId: 'belgrave',
    lat: -37.85, lon: 145.1, bearing: 90,
    timestamp: 1_700_000_000, canonicalX: 0.3, delay: 0, directionId: 0,
    prevStopId: 'p1', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
    nextStopId: 'n1', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 0, nextArrivalEpoch: 0, predictedNextArrivalEpoch: 0,
    segmentSpeedKmh: null, upcomingStops: [],
    ...overrides,
  };
}

function makeStream(tripId: string, canonicalX: number, overrides: Partial<StreamedPosition> = {}): StreamedPosition {
  return {
    tripId, canonicalX,
    prevStopId: 'p1', prevStopName: 'Richmond Station', prevStopCanonicalX: 0.1,
    nextStopId: 'n1', nextStopName: 'Camberwell Station', nextStopCanonicalX: 0.5,
    scheduledNextArrivalEpoch: 0, nextArrivalEpoch: 0, predictedNextArrivalEpoch: 0,
    segmentSpeedKmh: null,
    ...overrides,
  };
}

beforeEach(() => {
  useTrainsStore.setState({ positions: new Map(), streamedX: new Map() });
});

describe('trainsStore', () => {
  describe('applyUpdate', () => {
    it('adds new vehicles to positions', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1'), makePos('t2')]);
      const { positions } = useTrainsStore.getState();
      expect(positions.size).toBe(2);
      expect(positions.has('t1')).toBe(true);
      expect(positions.has('t2')).toBe(true);
    });

    it('overwrites an existing vehicle with the same tripId', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { canonicalX: 0.3 })]);
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { canonicalX: 0.6 })]);
      expect(useTrainsStore.getState().positions.get('t1')!.canonicalX).toBe(0.6);
    });

    it('preserves other vehicles when updating one', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1'), makePos('t2')]);
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { canonicalX: 0.9 })]);
      expect(useTrainsStore.getState().positions.has('t2')).toBe(true);
    });

    it('does not mutate the previous positions Map', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1')]);
      const before = useTrainsStore.getState().positions;
      useTrainsStore.getState().actions.applyUpdate([makePos('t2')]);
      expect(before.has('t2')).toBe(false);
    });

    it('handles an empty update array gracefully', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1')]);
      useTrainsStore.getState().actions.applyUpdate([]);
      expect(useTrainsStore.getState().positions.size).toBe(1);
    });
  });

  describe('applyStream', () => {
    it('records canonicalX in streamedX', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1')]);
      useTrainsStore.getState().actions.applyStream([makeStream('t1', 0.42)]);
      expect(useTrainsStore.getState().streamedX.get('t1')).toBe(0.42);
    });

    it('merges segment data into existing position', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { nextStopName: 'Camberwell Station' })]);
      useTrainsStore.getState().actions.applyStream([makeStream('t1', 0.45, {
        nextStopId: 'n2', nextStopName: 'Hartwell Station', nextStopCanonicalX: 0.6,
      })]);
      const pos = useTrainsStore.getState().positions.get('t1')!;
      expect(pos.nextStopName).toBe('Hartwell Station');
      expect(pos.nextStopCanonicalX).toBe(0.6);
    });

    it('preserves position fields not in the stream (e.g. lineId, lat, lon)', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { lineId: 'alamein', lat: -37.99 })]);
      useTrainsStore.getState().actions.applyStream([makeStream('t1', 0.45)]);
      const pos = useTrainsStore.getState().positions.get('t1')!;
      expect(pos.lineId).toBe('alamein');
      expect(pos.lat).toBe(-37.99);
    });

    it('updates streamedX even when the tripId has no existing position', () => {
      useTrainsStore.getState().actions.applyStream([makeStream('unknown', 0.55)]);
      expect(useTrainsStore.getState().streamedX.get('unknown')).toBe(0.55);
      // Should not have created a position for it
      expect(useTrainsStore.getState().positions.has('unknown')).toBe(false);
    });

    it('handles multiple stream updates in one call', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1'), makePos('t2')]);
      useTrainsStore.getState().actions.applyStream([
        makeStream('t1', 0.4),
        makeStream('t2', 0.7),
      ]);
      expect(useTrainsStore.getState().streamedX.get('t1')).toBe(0.4);
      expect(useTrainsStore.getState().streamedX.get('t2')).toBe(0.7);
    });

    it('merges stream epoch 0 into position (display layer must use || not ?? to recover poll value)', () => {
      // Scenario: poll gave a valid nextArrivalEpoch; stream then sends 0 (no schedule data).
      // The store faithfully merges 0 (stream is more recent). The display layer is responsible
      // for recovering poll value via `||` — this test documents the store contract.
      const validEpoch = 1_700_100_000;
      useTrainsStore.getState().actions.applyUpdate([makePos('t1', { nextArrivalEpoch: validEpoch })]);
      useTrainsStore.getState().actions.applyStream([makeStream('t1', 0.45, { nextArrivalEpoch: 0 })]);
      const pos = useTrainsStore.getState().positions.get('t1')!;
      // Store merges 0 — the display layer (TrainInfoPanel) uses `||` to fall back to valid data
      expect(pos.nextArrivalEpoch).toBe(0);
    });

    it('does not change positions when no matching tripId exists (only streamedX changes)', () => {
      useTrainsStore.getState().actions.applyUpdate([makePos('t1')]);
      const beforePositions = useTrainsStore.getState().positions;
      useTrainsStore.getState().actions.applyStream([makeStream('unknown', 0.5)]);
      // positions Map reference should be unchanged (no posChanged path)
      expect(useTrainsStore.getState().positions).toBe(beforePositions);
    });
  });
});
