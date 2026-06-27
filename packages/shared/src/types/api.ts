import type { LineDefinition } from './gtfs.js';
import type { VehiclePosition } from './realtime.js';

export interface ApiLinesResponse {
  lines: LineDefinition[];
}

export interface ApiVehiclesResponse {
  vehicles: VehiclePosition[];
}

export interface SocketVehiclesUpdate {
  vehicles: VehiclePosition[];
}

export interface SocketRoomsJoin {
  lines: string[];
}

export interface SocketRoomsLeave {
  lines: string[];
}
