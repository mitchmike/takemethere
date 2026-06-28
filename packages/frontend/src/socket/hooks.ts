import { useEffect } from 'react';
import { socket } from './client.js';
import { useTrainsStore } from '../store/trainsStore.js';
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
