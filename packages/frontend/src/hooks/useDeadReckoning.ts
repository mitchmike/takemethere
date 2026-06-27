import { useTrainsStore } from '../store/trainsStore.js';
import { useAnimationFrame } from './useAnimationFrame.js';
import { deadReckonFraction } from '@takemethere/shared';

/**
 * Runs on every animation frame and advances train fractions via dead-reckoning.
 * Updates trainsStore.positions in place using direct mutation for perf
 * (Zustand's immer-style set would trigger too many re-renders).
 */
export function useDeadReckoning(): void {
  const positions = useTrainsStore(s => s.positions);

  useAnimationFrame((now) => {
    for (const pos of positions.values()) {
      if (pos.scheduledArrivalEpoch === 0) continue;
      pos.fraction = deadReckonFraction(
        pos.lastGtfsFraction,
        pos.lastGtfsTimestamp,
        pos.scheduledDepartureEpoch,
        pos.scheduledArrivalEpoch,
        now,
      );
    }
  });
}
