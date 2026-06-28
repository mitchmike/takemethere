import type { LivePosition } from '@takemethere/shared';

export interface ArrivalTime {
  tripId: string;
  directionId: number | null;
  adjustedArrivalEpoch: number;
  predictedArrivalEpoch: number;
}

const MAX_PER_STOP = 3;

function normName(name: string): string {
  return name.replace(/ Station$/, '').toLowerCase().trim();
}

export function getArrivalsForStop(
  stopId: string,
  stopName: string,
  allPositions: Map<string, LivePosition>,
  lineId: string,
  directionFilter: 'inbound' | 'outbound' | 'both',
  nowSec: number,
  priorityTripId?: string | null,
): ArrivalTime[] {
  const norm = normName(stopName);
  const results: ArrivalTime[] = [];

  for (const [tripId, pos] of allPositions) {
    if (pos.lineId !== lineId) continue;
    if (directionFilter === 'outbound' && pos.directionId !== 0) continue;
    if (directionFilter === 'inbound' && pos.directionId !== 1) continue;
    const u = pos.upcomingStops.find(s =>
      s.stopId === stopId || normName(s.stopName) === norm,
    );
    if (u && u.adjustedArrivalEpoch > nowSec) {
      results.push({
        tripId,
        directionId: pos.directionId,
        adjustedArrivalEpoch: u.adjustedArrivalEpoch,
        predictedArrivalEpoch: u.predictedArrivalEpoch,
      });
    }
  }

  // Always include the selected (priority) trip even if its lineId differs from the strip's lineId.
  // Guards against lineId format mismatches between the position feed and line definitions.
  if (priorityTripId && !results.some(r => r.tripId === priorityTripId)) {
    const pos = allPositions.get(priorityTripId);
    if (pos) {
      if (
        (directionFilter === 'both') ||
        (directionFilter === 'outbound' && pos.directionId === 0) ||
        (directionFilter === 'inbound'  && pos.directionId === 1)
      ) {
        const u = pos.upcomingStops.find(s =>
          s.stopId === stopId || normName(s.stopName) === norm,
        );
        if (u && u.adjustedArrivalEpoch > nowSec) {
          results.push({
            tripId: priorityTripId,
            directionId: pos.directionId,
            adjustedArrivalEpoch: u.adjustedArrivalEpoch,
            predictedArrivalEpoch: u.predictedArrivalEpoch,
          });
        }
      }
    }
  }

  return results
    .sort((a, b) => a.adjustedArrivalEpoch - b.adjustedArrivalEpoch)
    .slice(0, MAX_PER_STOP);
}
