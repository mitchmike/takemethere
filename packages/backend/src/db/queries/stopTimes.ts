import { pool } from '../client.js';
import type { StopTime } from '@takemethere/shared';

export async function getStopTimesForTrip(tripId: string): Promise<StopTime[]> {
  const { rows } = await pool.query<{
    trip_id: string;
    stop_sequence: number;
    stop_id: string;
    arrival_time: number | null;
    departure_time: number | null;
  }>(
    `SELECT trip_id, stop_sequence, stop_id, arrival_time, departure_time
     FROM stop_times
     WHERE trip_id = $1
     ORDER BY stop_sequence`,
    [tripId],
  );

  return rows.map(r => ({
    tripId: r.trip_id,
    stopSequence: r.stop_sequence,
    stopId: r.stop_id,
    arrivalTime: r.arrival_time,
    departureTime: r.departure_time,
  }));
}
