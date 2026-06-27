import { create } from 'zustand';
import type { LineDefinition } from '@takemethere/shared';

type DirectionFilter = 'inbound' | 'outbound' | 'both';
type Orientation = 'horizontal' | 'vertical';

interface LinesState {
  lines: LineDefinition[];
  selectedLineIds: Set<string>;
  directionFilter: DirectionFilter;
  orientation: Orientation;
  actions: {
    setLines(lines: LineDefinition[]): void;
    toggleLine(lineId: string): void;
    setDirection(d: DirectionFilter): void;
    setOrientation(o: Orientation): void;
  };
}

export const useLinesStore = create<LinesState>((set) => ({
  lines: [],
  selectedLineIds: new Set(),
  directionFilter: 'both',
  orientation: 'horizontal',
  actions: {
    setLines: (lines) =>
      set({ lines, selectedLineIds: new Set(lines.map(l => l.lineId)) }),
    toggleLine: (lineId) =>
      set(state => {
        const next = new Set(state.selectedLineIds);
        if (next.has(lineId)) next.delete(lineId);
        else next.add(lineId);
        return { selectedLineIds: next };
      }),
    setDirection: (directionFilter) => set({ directionFilter }),
    setOrientation: (orientation) => set({ orientation }),
  },
}));
