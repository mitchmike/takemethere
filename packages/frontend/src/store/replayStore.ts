import { create } from 'zustand';

export interface ReplayState {
  mode: 'live' | 'replay';
  session: string | null;
  snapshotIndex: number;
  totalSnapshots: number;
  speed: number;
  capturedAt: string | null;
}

interface ReplayStore {
  replay: ReplayState;
  actions: {
    setMode(update: Partial<ReplayState>): void;
  };
}

export const useReplayStore = create<ReplayStore>(set => ({
  replay: {
    mode: 'live',
    session: null,
    snapshotIndex: 0,
    totalSnapshots: 0,
    speed: 1,
    capturedAt: null,
  },
  actions: {
    setMode: (update) => set(s => ({ replay: { ...s.replay, ...update } })),
  },
}));
