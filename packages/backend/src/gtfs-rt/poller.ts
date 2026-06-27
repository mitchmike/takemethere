import type { Server } from 'socket.io';
import { config } from '../config.js';
import { decodeFeed, extractVehiclePositions, extractTripUpdates } from './decoder.js';
import { publishPositions, getPublishStats } from './publisher.js';
import type { PublishStats } from './publisher.js';

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

async function poll(): Promise<void> {
  const t0 = Date.now();
  try {
    const [vpBuf, tuBuf] = await Promise.all([
      fetchFeed(config.PTV_GTFS_RT_URL),
      fetchFeed(config.PTV_GTFS_RT_TU_URL),
    ]);

    const vpFeed = decodeFeed(vpBuf);
    const tuFeed = decodeFeed(tuBuf);

    const positions = extractVehiclePositions(vpFeed);
    const tripUpdates = extractTripUpdates(tuFeed);

    if (ioRef) await publishPositions(ioRef, positions, tripUpdates);

    status.pollCount++;
    status.lastPollAt = new Date().toISOString();
    status.lastError = null;
    status.lastPollMs = Date.now() - t0;
    status.publishStats = getPublishStats();
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error('[poller] Error:', err);
  }
}

export function startPoller(io: Server): void {
  if (status.running) return;
  ioRef = io;
  status.running = true;
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
