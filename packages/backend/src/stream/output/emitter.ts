/**
 * Tick emitter — runs at 1s intervals, reads the position store, interpolates
 * each train's current position, and emits vehicles:stream to subscribed rooms.
 *
 * This is the output stage of the streaming fast-path. The poller feeds data
 * in every 30s; the emitter smooths movement between polls.
 */

import type { Server } from 'socket.io';
import type { StreamedPosition } from '@takemethere/shared';
import { positionStore, removeLivePosition } from '../engine/position_store.js';
import { computeInterpolatedX, tryAdvanceSegment } from '../engine/linear_interp.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startStreamer(io: Server, intervalMs = 1000): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(() => {
    const nowSec = Date.now() / 1000;
    const byLine = new Map<string, StreamedPosition[]>();
    const toRemove: string[] = [];

    for (let [tripId, pos] of positionStore.entries()) {
      if (pos.canonicalX < 0) continue;
      const room = `line:${pos.lineId}`;
      if (!io.sockets.adapter.rooms.get(room)?.size) continue;

      let interpX = computeInterpolatedX(pos, nowSec);

      const advanced = tryAdvanceSegment(pos, interpX, nowSec);
      if (advanced) {
        positionStore.set(tripId, advanced);
        pos = advanced;
        interpX = computeInterpolatedX(pos, nowSec);
      }

      const atTerminus = !pos.nextStopId && pos.nextStopCanonicalX < 0;
      const atStation  = atTerminus || (
        pos.prevStopCanonicalX >= 0
        && Math.abs(interpX - pos.prevStopCanonicalX) < 0.005
      );

      if (atTerminus) {
        const lingered = positionStore.trackTerminus(tripId, nowSec);
        if (lingered === 0) {
          console.log(`[emitter] ${tripId} reached trip terminus at ${pos.prevStopName ?? '?'}`);
        }
        if (positionStore.shouldRemoveAfterLinger(tripId, nowSec)) {
          toRemove.push(tripId);
          continue;
        }
      }

      const streamed: StreamedPosition = {
        tripId,
        canonicalX: atTerminus ? pos.canonicalX : interpX,

        prevStopId:         pos.prevStopId,
        prevStopName:       pos.prevStopName,
        prevStopCanonicalX: pos.prevStopCanonicalX,

        nextStopId:         pos.nextStopId,
        nextStopName:       pos.nextStopName,
        nextStopCanonicalX: pos.nextStopCanonicalX,

        scheduledNextArrivalEpoch: pos.scheduledNextArrivalEpoch,
        nextArrivalEpoch:          pos.nextArrivalEpoch,
        predictedNextArrivalEpoch: pos.predictedNextArrivalEpoch,

        segmentSpeedKmh: pos.segmentSpeedKmh,
        atStation,
      };

      if (!byLine.has(pos.lineId)) byLine.set(pos.lineId, []);
      byLine.get(pos.lineId)!.push(streamed);
    }

    for (const tripId of toRemove) {
      removeLivePosition(tripId);
      console.log(`[emitter] ${tripId} removed after linger`);
    }

    for (const [lineId, positions] of byLine) {
      io.to(`line:${lineId}`).emit('vehicles:stream', positions);
    }
  }, intervalMs);

  console.log(`[emitter] Started — emitting every ${intervalMs}ms`);
}

export function stopStreamer(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  positionStore.clear();
  console.log('[emitter] Stopped');
}
