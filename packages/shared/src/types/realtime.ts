export interface VehiclePosition {
  tripId: string | null;
  routeId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  timestamp: number;
  currentStopSequence: number | null;
  currentStatus: VehicleStopStatus | null;
}

export enum VehicleStopStatus {
  INCOMING_AT = 0,
  STOPPED_AT = 1,
  IN_TRANSIT_TO = 2,
}

/** Server-computed position combining VP (GPS) and TU (schedule/delay) feeds. */
export interface LivePosition {
  tripId: string;
  lineId: string;
  lat: number;
  lon: number;
  bearing: number | null;
  timestamp: number;            // epoch seconds when GPS was captured
  canonicalX: number;           // GPS-projected position [0,1]; -1 if unmappable
  // Dead-reckoning fields from trip update (0 / null if no TU match)
  delay: number;                // seconds late (positive = late)
  nextStopId: string | null;
  nextStopCanonicalX: number;   // canonicalX of next stop; -1 if unknown
  nextArrivalEpoch: number;     // absolute epoch of next arrival (incl. delay); 0 if unknown
}
