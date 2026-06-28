/**
 * PTV GTFS-RT poller — fetches vehicle position and trip update feeds from PTV
 * every 30s and hands them to the publisher.
 */

import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { decodeFeed, extractVehiclePositions, extractTripUpdates } from './position_decoder.js';
import { publishPositions, getPublishStats } from '../output/publisher.js';
import type { PublishStats } from '../output/publisher.js';
import { loadMissingStopTimes, epochToMelbTime } from '../engine/static_data.js';
import { redis } from '../../redis/client.js';
import { keys } from '../../redis/keys.js';

export interface PollerStatus {
  running: boolean;
  pollCount: number;
  lastPollAt: string | null;
  lastError: string | null;
  lastPollMs: number | null;
  publishStats: PublishStats;
}

const status: PollerStatus = {
  running: false,
  pollCount: 0,
  lastPollAt: null,
  lastError: null,
  lastPollMs: null,
  publishStats: {
    vehicleCount: 0,
    vehiclesByLine: [],
    unmappedCount: 0,
    tuMatchCount: 0,
    redisVehicleCount: 0,
    snapshotAt: null,
  },
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ioRef: Server | null = null;

async function fetchFeed(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'KeyId': config.PTV_API_KEY } });
  if (!res.ok) throw new Error(`GTFS-RT fetch failed: ${res.status} ${res.statusText} (${url})`);
  return Buffer.from(await res.arrayBuffer());
}

const DEBUG_TRIP = '02-GWY--52-T3-2197';

async function poll(): Promise<void> {
  const t0 = Date.now();
  try {
    const [vpBuf, tuBuf] = await Promise.all([
      fetchFeed(config.PTV_GTFS_RT_URL),
      fetchFeed(config.PTV_GTFS_RT_TU_URL),
    ]);

    const vpFeed = decodeFeed(vpBuf);
    const tuFeed = decodeFeed(tuBuf);

    const positions   = extractVehiclePositions(vpFeed);
    const tripUpdates = extractTripUpdates(tuFeed);

    const now = Date.now() / 1000;
    const debugVp = positions.find(p => p.tripId === DEBUG_TRIP);
    const debugTu = tripUpdates.get(DEBUG_TRIP);
    if (debugVp || debugTu) {
      console.log(`\n[DEBUG ${DEBUG_TRIP}] poll #${status.pollCount + 1} at ${new Date().toISOString()}`);
      if (debugVp) {
        console.log('  VP raw:', {
          lat: debugVp.lat.toFixed(5), lon: debugVp.lon.toFixed(5),
          bearing: debugVp.bearing,
          timestamp: debugVp.timestamp,
          timestampAge: `${Math.round(now - debugVp.timestamp)}s ago`,
        });
      } else {
        console.log('  VP raw: NOT IN FEED');
      }
      if (debugTu) {
        console.log('  TU raw:', {
          delay: debugTu.delay,
          nextStopId: debugTu.nextStopId,
          nextArrivalEpoch: debugTu.nextArrivalEpoch,
          nextArrivalIn: `${Math.round(debugTu.nextArrivalEpoch - now)}s`,
          total: debugTu.nextArrivalEpoch > 0
            ? `${Math.round(debugTu.nextArrivalEpoch - (debugVp?.timestamp ?? now))}s`
            : 'N/A',
        });
      } else {
        console.log('  TU raw: NO MATCH');
      }
    } else {
      console.log(`[DEBUG ${DEBUG_TRIP}] not in this poll`);
    }

    if (ioRef) await publishPositions(ioRef, positions, tripUpdates);

    const activeTripIds = positions.map(p => p.tripId).filter(Boolean) as string[];
    loadMissingStopTimes(activeTripIds).catch(err => console.warn('[poller] stop_times load error:', err));

    const raw = await redis.get(keys.vehicle(DEBUG_TRIP));
    if (raw) {
      const live = JSON.parse(raw);
      const now2 = Date.now() / 1000;
      const total   = live.nextArrivalEpoch - live.timestamp;
      const elapsed = now2 - live.timestamp;
      const t       = total > 0 ? Math.min(1, elapsed / total) : null;
      console.log('  LivePosition:', {
        segment:    `${live.prevStopName ?? '?'} → ${live.nextStopName ?? '?'}`,
        canonicalX: typeof live.canonicalX === 'number' ? live.canonicalX.toFixed(4) : live.canonicalX,
        gpsAge:     `${Math.round(elapsed)}s`,
        t:          t !== null ? t.toFixed(3) : 'N/A',
        speedKmh:   live.segmentSpeedKmh != null ? live.segmentSpeedKmh.toFixed(1) : null,
        delay:      `${live.delay}s`,
        directionId: live.directionId,
        scheduled:  epochToMelbTime(live.scheduledNextArrivalEpoch),
        adjusted:   epochToMelbTime(live.nextArrivalEpoch),
        predicted:  epochToMelbTime(live.predictedNextArrivalEpoch),
        upcoming:   (live.upcomingStops ?? []).slice(0, 3).map((s: { stopId: string; adjustedArrivalEpoch: number }) =>
          `${s.stopId}@${epochToMelbTime(s.adjustedArrivalEpoch)}`),
      });
    } else {
      console.log('  LivePosition: NOT IN REDIS');
    }

    status.pollCount++;
    status.lastPollAt  = new Date().toISOString();
    status.lastError   = null;
    status.lastPollMs  = Date.now() - t0;
    status.publishStats = getPublishStats();
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error('[poller] Error:', err);
  }
}

export function startPoller(io: Server): void {
  if (status.running) return;
  ioRef = io;
  status.running   = true;
  status.lastError = null;
  poll();
  intervalHandle = setInterval(poll, config.GTFS_RT_POLL_INTERVAL_MS);
  console.log(`[poller] Started — polling every ${config.GTFS_RT_POLL_INTERVAL_MS / 1000}s`);
}

export function stopPoller(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  status.running = false;
  console.log('[poller] Stopped');
}

export function getPollerStatus(): PollerStatus {
  return { ...status, publishStats: { ...status.publishStats } };
}
