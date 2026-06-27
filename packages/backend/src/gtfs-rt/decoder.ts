import * as gtfsRt from 'gtfs-realtime-bindings';
const { transit_realtime } = gtfsRt;
import type { VehiclePosition, LivePosition } from '@takemethere/shared';
import { VehicleStopStatus } from '@takemethere/shared';

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
