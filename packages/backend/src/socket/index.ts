import type { Server } from 'socket.io';
import { registerLineRoomHandlers } from './handlers/lineRoom.js';

export function setupSocket(io: Server): void {
  io.on('connection', socket => {
    registerLineRoomHandlers(socket);
  });
}
