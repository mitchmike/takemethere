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

export interface LivePosition {
  tripId: string;
  lineId: string;
  stopSequenceBefore: number;
  stopSequenceAfter: number;
  fraction: number;
  lastGtfsTimestamp: number;
  lastGtfsFraction: number;
  scheduledDepartureEpoch: number;
  scheduledArrivalEpoch: number;
}
