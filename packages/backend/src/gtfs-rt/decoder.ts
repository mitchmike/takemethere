import gtfsRt from 'gtfs-realtime-bindings';
const { transit_realtime } = gtfsRt;
import type { VehiclePosition } from '@takemethere/shared';
import { VehicleStopStatus } from '@takemethere/shared';

export interface TripUpdateEntry {
  tripId: string;
  routeId: string | null;
  delay: number;               // seconds (from TU-level delay field; 0 if not set)
  nextStopId: string | null;   // stopId of next upcoming stop
  nextStopSeq: number | null;
  nextArrivalEpoch: number;    // absolute epoch seconds (with delay); 0 if unavailable
}

export function decodeFeed(buffer: Buffer): transit_realtime.FeedMessage {
  return transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

export function extractVehiclePositions(feed: transit_realtime.FeedMessage): VehiclePosition[] {
  return feed.entity
    .filter(e => e.vehicle?.position != null)
    .map(e => {
      const v = e.vehicle!;
      return {
        tripId: v.trip?.tripId ?? null,
        routeId: v.trip?.routeId ?? null,
        lat: v.position!.latitude,
        lon: v.position!.longitude,
        bearing: v.position!.bearing ?? null,
        speed: v.position!.speed ?? null,
        timestamp: Number(v.timestamp ?? 0),
        currentStopSequence: v.currentStopSequence ?? null,
        currentStatus: (v.currentStatus as unknown as VehicleStopStatus) ?? null,
      };
    });
}

export function extractTripUpdates(feed: transit_realtime.FeedMessage): Map<string, TripUpdateEntry> {
  const result = new Map<string, TripUpdateEntry>();
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip?.tripId) continue;

    const tripId = tu.trip.tripId;
    const routeId = tu.trip.routeId ?? null;

    // stopTimeUpdate is sorted by stopSequence; first entry = next upcoming stop
    const next = tu.stopTimeUpdate?.[0];
    const nextStopId = next?.stopId ?? null;
    const nextStopSeq = next?.stopSequence ?? null;

    // arrival.time is a Long — convert to number (epoch seconds)
    const rawTime = next?.arrival?.time ?? next?.departure?.time;
    const nextArrivalEpoch = rawTime ? Number(rawTime) : 0;

    // Use the arrival delay of the next stop as the current delay
    const delay = next?.arrival?.delay ?? next?.departure?.delay ?? 0;

    result.set(tripId, { tripId, routeId, delay, nextStopId, nextStopSeq, nextArrivalEpoch });
  }
  return result;
}
