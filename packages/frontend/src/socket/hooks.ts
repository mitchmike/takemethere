import { useEffect } from 'react';
import { socket } from './client.js';
import { useTrainsStore } from '../store/trainsStore.js';
import { useReplayStore } from '../store/replayStore.js';
import type { LivePosition, StreamedPosition } from '@takemethere/shared';

export function useLineRoom(lineIds: string[]): void {
  const applyUpdate = useTrainsStore(s => s.actions.applyUpdate);
  const applyStream = useTrainsStore(s => s.actions.applyStream);

  useEffect(() => {
    if (lineIds.length === 0) return;

    socket.emit('rooms:join', { lines: lineIds });

    const onUpdate = (vehicles: LivePosition[]) => applyUpdate(vehicles);
    const onStream = (positions: StreamedPosition[]) => applyStream(positions);

    socket.on('vehicles:update', onUpdate);
    socket.on('vehicles:stream', onStream);

    return () => {
      socket.emit('rooms:leave', { lines: lineIds });
      socket.off('vehicles:update', onUpdate);
      socket.off('vehicles:stream', onStream);
    };
  }, [lineIds.join(','), applyUpdate, applyStream]);
}

interface ModeUpdate {
  mode: 'live' | 'replay';
  session?: string;
  snapshotIndex?: number;
  totalSnapshots?: number;
  speed?: number;
  capturedAt?: string;
}

export function useReplayMode(): void {
  const setMode = useReplayStore(s => s.actions.setMode);

  useEffect(() => {
    const onMode = (update: ModeUpdate) => {
      if (update.mode === 'live') {
        setMode({ mode: 'live', session: null, snapshotIndex: 0, totalSnapshots: 0, capturedAt: null });
      } else {
        setMode({
          mode: 'replay',
          session: update.session ?? null,
          snapshotIndex: update.snapshotIndex ?? 0,
          totalSnapshots: update.totalSnapshots ?? 0,
          speed: update.speed ?? 1,
          capturedAt: update.capturedAt ?? null,
        });
      }
    };
    socket.on('mode:update', onMode);
    return () => { socket.off('mode:update', onMode); };
  }, [setMode]);
}
