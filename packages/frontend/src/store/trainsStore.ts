import { create } from 'zustand';
import type { LivePosition, StreamedPosition } from '@takemethere/shared';

interface TrainsState {
  positions: Map<string, LivePosition>;
  // Server-computed interpolated canonicalX, updated at 1Hz from vehicles:stream
  streamedX: Map<string, number>;
  actions: {
    applyUpdate(vehicles: LivePosition[]): void;
    applyStream(updates: StreamedPosition[]): void;
  };
}

export const useTrainsStore = create<TrainsState>((set) => ({
  positions: new Map(),
  streamedX: new Map(),
  actions: {
    applyUpdate: (vehicles) =>
      set(state => {
        const next = new Map(state.positions);
        for (const v of vehicles) next.set(v.tripId, v);
        return { positions: next };
      }),

    applyStream: (updates) =>
      set(state => {
        const nextX   = new Map(state.streamedX);
        const nextPos = new Map(state.positions);
        let posChanged = false;

        for (const u of updates) {
          nextX.set(u.tripId, u.canonicalX);

          // Merge segment + ETA updates from stream into live positions.
          // The poll (vehicles:update) is authoritative; stream fills in between polls.
          const existing = nextPos.get(u.tripId);
          if (existing) {
            nextPos.set(u.tripId, {
              ...existing,
              prevStopId:         u.prevStopId,
              prevStopName:       u.prevStopName,
              prevStopCanonicalX: u.prevStopCanonicalX,
              nextStopId:         u.nextStopId,
              nextStopName:       u.nextStopName,
              nextStopCanonicalX: u.nextStopCanonicalX,
              scheduledNextArrivalEpoch: u.scheduledNextArrivalEpoch,
              nextArrivalEpoch:          u.nextArrivalEpoch,
              predictedNextArrivalEpoch: u.predictedNextArrivalEpoch,
              segmentSpeedKmh:   u.segmentSpeedKmh,
            });
            posChanged = true;
          }
        }

        return posChanged ? { streamedX: nextX, positions: nextPos } : { streamedX: nextX };
      }),
  },
}));
