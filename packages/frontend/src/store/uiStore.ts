import { create } from 'zustand';
import { adjustZoomViewport } from '../components/LineMap/viewport.js';
import type { Viewport } from '../components/LineMap/viewport.js';

export type { Viewport };

interface UiState {
  selectedTripId: string | null;
  selectedStopName: string | null;
  viewport: Viewport | null;
  actions: {
    selectTrip(tripId: string | null): void;
    selectStop(stopName: string | null): void;
    setViewport(v: Viewport | null): void;
    nudgeViewportCenter(center: number): void;
    adjustZoom(factor: number): void;
  };
}

export const useUiStore = create<UiState>((set) => ({
  selectedTripId: null,
  selectedStopName: null,
  viewport: null,
  actions: {
    // Selecting a trip clears any station selection (mutually exclusive)
    selectTrip: (selectedTripId) => set({ selectedTripId, selectedStopName: null }),
    // Selecting a stop clears any trip selection (mutually exclusive)
    selectStop: (selectedStopName) => set({ selectedStopName, selectedTripId: null }),
    setViewport: (viewport) => set({ viewport }),
    nudgeViewportCenter: (center) => set((s) =>
      s.viewport ? { viewport: { ...s.viewport, center } } : {},
    ),
    adjustZoom: (factor) => set((s) =>
      s.viewport ? { viewport: adjustZoomViewport(s.viewport, factor) } : {},
    ),
  },
}));
