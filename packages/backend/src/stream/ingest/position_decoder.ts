import gtfsRt from 'gtfs-realtime-bindings';
const { transit_realtime } = gtfsRt;
import type { VehiclePosition } from '@takemethere/shared';
import { VehicleStopStatus } from '@takemethere/shared';

export interface StopTimeUpdate {
  stopId: string;
  stopSeq: number;
  arrivalEpoch: number;
  departureEpoch: number;
  arrivalDelay: number;
  departureDelay: number;
}

export interface TripUpdateEntry {
  tripId: string;
  routeId: string | null;
  delay: number;
  nextStopId: string | null;
  nextStopSeq: number | null;
  nextArrivalEpoch: number;
  allStopUpdates: StopTimeUpdate[];
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

    const tripId  = tu.trip.tripId;
    const routeId = tu.trip.routeId ?? null;

    const nowEpoch  = Date.now() / 1000;
    const rawUpdates = tu.stopTimeUpdate ?? [];

    // Find first stop still in the future (60s buffer handles trains currently at a stop).
    const nextIdx = rawUpdates.findIndex(stu => {
      const t = stu.arrival?.time ?? stu.departure?.time;
      return t && Number(t) > nowEpoch - 60;
    });

    // If all stops are in the past, fall back to the last (terminal) stop rather than the
    // first — rawUpdates[0] would be the trip start, potentially hours in the past.
    const next = nextIdx >= 0 ? rawUpdates[nextIdx] : (rawUpdates.at(-1) ?? rawUpdates[0]);
    const nextStopId      = next?.stopId ?? null;
    const nextStopSeq     = next?.stopSequence ?? null;
    const rawTime         = next?.arrival?.time ?? next?.departure?.time;
    const nextArrivalEpoch = rawTime ? Number(rawTime) : 0;
    const delay           = next?.arrival?.delay ?? next?.departure?.delay ?? 0;

    const futureSlice = nextIdx >= 0 ? rawUpdates.slice(nextIdx) : rawUpdates;
    const allStopUpdates: StopTimeUpdate[] = futureSlice.map(stu => ({
      stopId:          stu.stopId ?? '',
      stopSeq:         stu.stopSequence ?? 0,
      arrivalEpoch:    stu.arrival?.time ? Number(stu.arrival.time) : 0,
      departureEpoch:  stu.departure?.time ? Number(stu.departure.time) : 0,
      arrivalDelay:    stu.arrival?.delay ?? 0,
      departureDelay:  stu.departure?.delay ?? 0,
    }));

    result.set(tripId, { tripId, routeId, delay, nextStopId, nextStopSeq, nextArrivalEpoch, allStopUpdates });
  }
  return result;
}
