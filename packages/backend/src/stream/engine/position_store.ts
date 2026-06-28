/**
 * In-memory store of the most recent LivePosition per trip.
 * Updated by the publisher on each poll; read by the emitter on each tick.
 *
 * Using a class so tests can instantiate a fresh store without resetting module state.
 * The app uses the singleton `positionStore` exported at the bottom.
 */

import type { LivePosition } from '@takemethere/shared';
import { getTripStopTimesCache, getGlobalStopName, normalizeName } from './static_data.js';

const TERMINUS_LINGER_SEC = 15;

export class PositionStore {
  private readonly positions = new Map<string, LivePosition>();
  private readonly terminusArrivalTime = new Map<string, number>();

  /**
   * Stores the latest LivePosition for a trip.
   * Guards against GPS noise resetting a train that the engine has already
   * advanced to terminus (nextStopId=null → nextStopId≠null is suppressed).
   */
  update(pos: LivePosition): void {
    const existing = this.positions.get(pos.tripId);
    if (existing && existing.nextStopId === null && pos.nextStopId !== null) return;
    this.positions.set(pos.tripId, pos);
  }

  remove(tripId: string): void {
    this.positions.delete(tripId);
    this.terminusArrivalTime.delete(tripId);
  }

  get(tripId: string): LivePosition | undefined {
    return this.positions.get(tripId);
  }

  entries(): IterableIterator<[string, LivePosition]> {
    return this.positions.entries();
  }

  set(tripId: string, pos: LivePosition): void {
    this.positions.set(tripId, pos);
  }

  /** Records when a trip first reached terminus; returns seconds since then. */
  trackTerminus(tripId: string, nowSec: number): number {
    if (!this.terminusArrivalTime.has(tripId)) {
      this.terminusArrivalTime.set(tripId, nowSec);
    }
    return nowSec - this.terminusArrivalTime.get(tripId)!;
  }

  shouldRemoveAfterLinger(tripId: string, nowSec: number): boolean {
    return this.trackTerminus(tripId, nowSec) >= TERMINUS_LINGER_SEC;
  }

  clear(): void {
    this.positions.clear();
    this.terminusArrivalTime.clear();
  }
}

export const positionStore = new PositionStore();

// ─── Convenience wrappers (preserve API surface used by publisher + emitter) ──

export function updateLivePosition(pos: LivePosition): void { positionStore.update(pos); }
export function removeLivePosition(tripId: string): void { positionStore.remove(tripId); }

// ─── Trip terminus helpers ────────────────────────────────────────────────────

export function getTripLastStopId(tripId: string): string | null {
  const stopTimes = getTripStopTimesCache(tripId);
  if (!stopTimes.length) return null;
  return stopTimes[stopTimes.length - 1].stopId;
}

export function isAtTripTerminus(tripId: string, stopId: string, stopName: string): boolean {
  const stopTimes = getTripStopTimesCache(tripId);
  if (!stopTimes.length) return false;
  const last = stopTimes[stopTimes.length - 1];
  if (last.stopId === stopId) return true;
  const lastGlobalName = getGlobalStopName(last.stopId);
  if (lastGlobalName && normalizeName(lastGlobalName) === normalizeName(stopName)) return true;
  return false;
}
