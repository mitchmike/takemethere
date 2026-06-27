import type { Socket } from 'socket.io';

export function registerLineRoomHandlers(socket: Socket): void {
  socket.on('rooms:join', ({ lines }: { lines: string[] }) => {
    for (const lineId of lines) {
      socket.join(`line:${lineId}`);
    }
  });

  socket.on('rooms:leave', ({ lines }: { lines: string[] }) => {
    for (const lineId of lines) {
      socket.leave(`line:${lineId}`);
    }
  });
}
