export interface Route {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeType: number;
  routeColor: string | null;
  lineId: string;
}

export interface Stop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
}

export interface Trip {
  tripId: string;
  routeId: string;
  serviceId: string;
  tripHeadsign: string | null;
  directionId: 0 | 1;
}

export interface StopTime {
  tripId: string;
  stopSequence: number;
  stopId: string;
  arrivalTime: number | null;   // seconds since midnight
  departureTime: number | null; // seconds since midnight
}

export interface LineStationEntry {
  lineId: string;
  stopId: string;
  stopName: string;
  canonicalPosition: number;
  canonicalX: number;
  stopLat: number;
  stopLon: number;
}

export interface LineDefinition {
  lineId: string;
  name: string;
  color: string;
  stops: LineStationEntry[];
}
