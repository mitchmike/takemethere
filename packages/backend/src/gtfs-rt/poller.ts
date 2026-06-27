import type { Server } from 'socket.io';
import { config } from '../config.js';
import { decodeFeed, extractVehiclePositions } from './decoder.js';
import { publishPositions } from './publisher.js';

export interface PollerStatus {
  running: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  vehicleCount: number;
}

const status: PollerStatus = {
  running: false,
  lastPollAt: null,
  lastError: null,
  vehicleCount: 0,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let ioRef: Server | null = null;

async function poll(): Promise<void> {
  try {
    const res = await fetch(config.PTV_GTFS_RT_URL, {
      headers: { 'Ocp-Apim-Subscription-Key': config.PTV_API_KEY },
    });
    if (!res.ok) throw new Error(`GTFS-RT fetch failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const feed = decodeFeed(buffer);
    const positions = extractVehiclePositions(feed);
    if (ioRef) await publishPositions(ioRef, positions);

    status.lastPollAt = new Date().toISOString();
    status.lastError = null;
    status.vehicleCount = positions.length;
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error('[poller] Error polling GTFS-RT:', err);
  }
}

export function startPoller(io: Server): void {
  if (status.running) return;
  ioRef = io;
  status.running = true;
  status.lastError = null;
  poll();
  intervalHandle = setInterval(poll, config.GTFS_RT_POLL_INTERVAL_MS);
}

export function stopPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  status.running = false;
}

export function getPollerStatus(): PollerStatus {
  return { ...status };
}
