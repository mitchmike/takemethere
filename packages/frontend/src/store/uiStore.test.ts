import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './uiStore.js';

const VIEWPORT = { center: 0.5, windowHalf: 0.2 };

beforeEach(() => {
  useUiStore.setState({
    selectedTripId: null,
    selectedStopName: null,
    viewport: null,
  });
});

describe('uiStore', () => {
  describe('selectTrip', () => {
    it('sets selectedTripId', () => {
      useUiStore.getState().actions.selectTrip('trip-1');
      expect(useUiStore.getState().selectedTripId).toBe('trip-1');
    });

    it('clears selectedStopName when a trip is selected', () => {
      useUiStore.setState({ selectedStopName: 'Flinders Street Station' });
      useUiStore.getState().actions.selectTrip('trip-1');
      expect(useUiStore.getState().selectedStopName).toBeNull();
    });

    it('clears selectedTripId when called with null', () => {
      useUiStore.setState({ selectedTripId: 'trip-1' });
      useUiStore.getState().actions.selectTrip(null);
      expect(useUiStore.getState().selectedTripId).toBeNull();
    });
  });

  describe('selectStop', () => {
    it('sets selectedStopName', () => {
      useUiStore.getState().actions.selectStop('Flinders Street Station');
      expect(useUiStore.getState().selectedStopName).toBe('Flinders Street Station');
    });

    it('clears selectedTripId when a stop is selected', () => {
      useUiStore.setState({ selectedTripId: 'trip-1' });
      useUiStore.getState().actions.selectStop('Flinders Street Station');
      expect(useUiStore.getState().selectedTripId).toBeNull();
    });

    it('clears selectedStopName when called with null', () => {
      useUiStore.setState({ selectedStopName: 'Flinders Street Station' });
      useUiStore.getState().actions.selectStop(null);
      expect(useUiStore.getState().selectedStopName).toBeNull();
    });

    it('trip and stop selection are mutually exclusive — selecting a stop after a trip clears the trip', () => {
      useUiStore.getState().actions.selectTrip('trip-1');
      useUiStore.getState().actions.selectStop('Flinders Street Station');
      const { selectedTripId, selectedStopName } = useUiStore.getState();
      expect(selectedTripId).toBeNull();
      expect(selectedStopName).toBe('Flinders Street Station');
    });

    it('trip and stop selection are mutually exclusive — selecting a trip after a stop clears the stop', () => {
      useUiStore.getState().actions.selectStop('Flinders Street Station');
      useUiStore.getState().actions.selectTrip('trip-1');
      const { selectedTripId, selectedStopName } = useUiStore.getState();
      expect(selectedTripId).toBe('trip-1');
      expect(selectedStopName).toBeNull();
    });
  });

  describe('setViewport', () => {
    it('sets the viewport', () => {
      useUiStore.getState().actions.setViewport(VIEWPORT);
      expect(useUiStore.getState().viewport).toEqual(VIEWPORT);
    });

    it('clears the viewport when set to null', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      useUiStore.getState().actions.setViewport(null);
      expect(useUiStore.getState().viewport).toBeNull();
    });
  });

  describe('nudgeViewportCenter', () => {
    it('updates center without changing windowHalf', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      useUiStore.getState().actions.nudgeViewportCenter(0.7);
      const vp = useUiStore.getState().viewport!;
      expect(vp.center).toBe(0.7);
      expect(vp.windowHalf).toBe(VIEWPORT.windowHalf);
    });

    it('is a no-op when viewport is null', () => {
      useUiStore.getState().actions.nudgeViewportCenter(0.7);
      expect(useUiStore.getState().viewport).toBeNull();
    });
  });

  describe('adjustZoom', () => {
    it('zooms in (factor < 1) shrinks windowHalf', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      useUiStore.getState().actions.adjustZoom(0.5);
      const vp = useUiStore.getState().viewport!;
      expect(vp.windowHalf).toBeLessThan(VIEWPORT.windowHalf);
    });

    it('zooms out (factor > 1) grows windowHalf', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      useUiStore.getState().actions.adjustZoom(2);
      const vp = useUiStore.getState().viewport!;
      expect(vp.windowHalf).toBeGreaterThan(VIEWPORT.windowHalf);
    });

    it('preserves center when zooming', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      useUiStore.getState().actions.adjustZoom(0.5);
      expect(useUiStore.getState().viewport!.center).toBe(VIEWPORT.center);
    });

    it('clamps windowHalf to a minimum so over-zooming does not collapse the view', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      for (let i = 0; i < 20; i++) {
        useUiStore.getState().actions.adjustZoom(0.1);
      }
      expect(useUiStore.getState().viewport!.windowHalf).toBeGreaterThan(0);
    });

    it('clamps windowHalf to a maximum so over-zooming out does not exceed [0,1]', () => {
      useUiStore.setState({ viewport: VIEWPORT });
      for (let i = 0; i < 20; i++) {
        useUiStore.getState().actions.adjustZoom(2);
      }
      expect(useUiStore.getState().viewport!.windowHalf).toBeLessThanOrEqual(1);
    });

    it('is a no-op when viewport is null', () => {
      useUiStore.getState().actions.adjustZoom(0.5);
      expect(useUiStore.getState().viewport).toBeNull();
    });
  });
});
