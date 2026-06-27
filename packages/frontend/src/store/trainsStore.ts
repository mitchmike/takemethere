import { create } from 'zustand';
import type { LivePosition, VehiclePosition } from '@takemethere/shared';

interface TrainsState {
  positions: Map<string, LivePosition>;
  actions: {
    applyUpdate(vehicles: VehiclePosition[], lineId: string): void;
  };
}

export const useTrainsStore = create<TrainsState>((set) => ({
  positions: new Map(),
  actions: {
    applyUpdate: (vehicles, lineId) =>
      set(state => {
        const next = new Map(state.positions);
        for (const v of vehicles) {
          if (!v.tripId) continue;
          const existing = next.get(v.tripId);
          next.set(v.tripId, {
            tripId: v.tripId,
            lineId,
            stopSequenceBefore: v.currentStopSequence ?? 0,
            stopSequenceAfter: (v.currentStopSequence ?? 0) + 1,
            fraction: existing?.fraction ?? 0,
            lastGtfsTimestamp: v.timestamp * 1000,
            lastGtfsFraction: existing?.fraction ?? 0,
            scheduledDepartureEpoch: 0,
            scheduledArrivalEpoch: 0,
          });
        }
        return { positions: next };
      }),
  },
}));
