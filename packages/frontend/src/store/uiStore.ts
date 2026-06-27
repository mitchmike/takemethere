import { create } from 'zustand';

interface UiState {
  selectedTripId: string | null;
  selectedStopId: string | null;
  actions: {
    selectTrip(tripId: string | null): void;
    selectStop(stopId: string | null): void;
  };
}

export const useUiStore = create<UiState>((set) => ({
  selectedTripId: null,
  selectedStopId: null,
  actions: {
    selectTrip: (selectedTripId) => set({ selectedTripId }),
    selectStop: (selectedStopId) => set({ selectedStopId }),
  },
}));
