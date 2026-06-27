import { create } from 'zustand';
import type { LivePosition } from '@takemethere/shared';

interface TrainsState {
  positions: Map<string, LivePosition>;
  actions: {
    applyUpdate(vehicles: LivePosition[]): void;
  };
}

export const useTrainsStore = create<TrainsState>((set) => ({
  positions: new Map(),
  actions: {
    applyUpdate: (vehicles) =>
      set(state => {
        const next = new Map(state.positions);
        for (const v of vehicles) {
          next.set(v.tripId, v);
        }
        return { positions: next };
      }),
  },
}));
