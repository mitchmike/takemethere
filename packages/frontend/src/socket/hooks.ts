import { useEffect } from 'react';
import { socket } from './client.js';
import { useTrainsStore } from '../store/trainsStore.js';
import type { LivePosition } from '@takemethere/shared';

export function useLineRoom(lineIds: string[]): void {
  const applyUpdate = useTrainsStore(s => s.actions.applyUpdate);

  useEffect(() => {
    if (lineIds.length === 0) return;

    socket.emit('rooms:join', { lines: lineIds });

    const handler = (vehicles: LivePosition[]) => {
      applyUpdate(vehicles);
    };

    socket.on('vehicles:update', handler);

    return () => {
      socket.emit('rooms:leave', { lines: lineIds });
      socket.off('vehicles:update', handler);
    };
  }, [lineIds.join(','), applyUpdate]);
}
