import { create } from 'zustand';

interface UiState {
  selectedTripId: string | null;
  selectedStopName: string | null;
  actions: {
    selectTrip(tripId: string | null): void;
    selectStop(stopName: string | null): void;
  };
}

export const useUiStore = create<UiState>((set) => ({
  selectedTripId: null,
  selectedStopName: null,
  actions: {
    selectTrip: (selectedTripId) => set({ selectedTripId }),
    selectStop: (selectedStopName) => set({ selectedStopName }),
  },
}));
