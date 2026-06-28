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

/** One stop in the merged static+TU upcoming schedule. */
export interface UpcomingStop {
  stopId: string;
  stopName: string;               // resolved from globalStopNames; falls back to stopId
  canonicalX: number;             // -1 if not on this line's canonical map
  scheduledArrivalEpoch: number;  // midnight + stop_times.arrival_time (no delay applied)
  adjustedArrivalEpoch: number;   // scheduledArrivalEpoch + effective delay (TU or inherited)
  predictedArrivalEpoch: number;  // GPS+speed based (0 if unknown)
  tuDelaySeconds: number | null;  // explicit per-stop delay from TU (null = not in TU)
}

/** Segment-level position update streamed every ~1s from the server.
 *  Includes full segment state so the frontend never goes stale between polls. */
export interface StreamedPosition {
  tripId: string;
  canonicalX: number;

  prevStopId: string | null;
  prevStopName: string | null;
  prevStopCanonicalX: number;

  nextStopId: string | null;
  nextStopName: string | null;
  nextStopCanonicalX: number;

  scheduledNextArrivalEpoch: number;
  nextArrivalEpoch: number;
  predictedNextArrivalEpoch: number;

  segmentSpeedKmh: number | null;
  atStation: boolean;  // train is dwelling at prevStop (just arrived / not yet departed)
}

/** Server-computed position combining VP (GPS), TU (schedule/delay) and GTFS static. */
export interface LivePosition {
  tripId: string;
  lineId: string;
  lat: number;
  lon: number;
  bearing: number | null;
  timestamp: number;            // epoch seconds when GPS was captured

  // GPS-projected position [0,1] along the canonical line; -1 if unmappable
  canonicalX: number;

  // Current segment — prev is the last stop behind the train, next is the next stop ahead
  prevStopId: string | null;
  prevStopName: string | null;
  prevStopCanonicalX: number;   // -1 if unknown

  nextStopId: string | null;
  nextStopName: string | null;
  nextStopCanonicalX: number;   // -1 if unknown

  // Arrival time predictions at next stop (0 = unknown)
  scheduledNextArrivalEpoch: number;   // static schedule (no delay)
  nextArrivalEpoch: number;            // TU-adjusted or schedule-fallback
  predictedNextArrivalEpoch: number;   // GPS + segment-speed interpolation

  // Segment kinetics
  delay: number;                 // seconds late (positive = late, negative = early)
  segmentSpeedKmh: number | null;

  directionId: number | null;   // GTFS direction_id: 0=outbound, 1=inbound, null=unknown

  // Merged static+TU schedule for all remaining stops (empty until stop_times cached)
  upcomingStops: UpcomingStop[];
}
