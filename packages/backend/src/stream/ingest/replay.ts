import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { createInterface } from 'readline';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { redis } from '../../redis/client.js';
import type { Server } from 'socket.io';
import type { LivePosition } from '@takemethere/shared';

interface Snapshot {
  capturedAt: string;
  vehicles: LivePosition[];
}

export interface ReplayStatus {
  active: boolean;
  session: string | null;
  snapshotIndex: number;
  totalSnapshots: number;
  speed: number;
  startedAt: string | null;
  capturedAt: string | null;
}

export interface ModeUpdate {
  mode: 'live' | 'replay';
  session?: string;
  snapshotIndex?: number;
  totalSnapshots?: number;
  speed?: number;
  capturedAt?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = resolve(__dirname, '../../../data/sim-captures');

class ReplayController {
  private _status: ReplayStatus = {
    active: false,
    session: null,
    snapshotIndex: 0,
    totalSnapshots: 0,
    speed: 1,
    startedAt: null,
    capturedAt: null,
  };
  private abort: AbortController | null = null;

  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(CAPTURES_DIR);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  async start(sessionName: string, io: Server, speed = 1): Promise<void> {
    if (this._status.active) this.stop();

    const filePath = join(CAPTURES_DIR, `${sessionName}.jsonl`);
    const snapshots = await loadSnapshots(filePath);
    if (snapshots.length === 0) throw new Error(`No snapshots found in ${sessionName}`);

    this.abort = new AbortController();
    const { signal } = this.abort;

    this._status = {
      active: true,
      session: sessionName,
      snapshotIndex: 0,
      totalSnapshots: snapshots.length,
      speed,
      startedAt: new Date().toISOString(),
      capturedAt: snapshots[0].capturedAt,
    };

    const update: ModeUpdate = {
      mode: 'replay',
      session: sessionName,
      snapshotIndex: 0,
      totalSnapshots: snapshots.length,
      speed,
      capturedAt: snapshots[0].capturedAt,
    };
    io.emit('mode:update', update);

    this.runLoop(snapshots, io, speed, signal).catch(err => {
      if (err.name !== 'AbortError') console.error('[replay] Loop error:', err);
    });
  }

  private async runLoop(snapshots: Snapshot[], io: Server, speed: number, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < snapshots.length; i++) {
      if (signal.aborted) return;

      const snap = snapshots[i];
      this._status.snapshotIndex = i;
      this._status.capturedAt = snap.capturedAt;

      await emitSnapshot(snap, io);

      const update: ModeUpdate = {
        mode: 'replay',
        session: this._status.session ?? undefined,
        snapshotIndex: i,
        totalSnapshots: snapshots.length,
        speed,
        capturedAt: snap.capturedAt,
      };
      io.emit('mode:update', update);

      if (i < snapshots.length - 1) {
        const gap = new Date(snapshots[i + 1].capturedAt).getTime() - new Date(snap.capturedAt).getTime();
        await sleep(Math.max(0, gap / speed), signal);
      }
    }

    if (!signal.aborted) {
      this._status.active = false;
      this._status.session = null;
      io.emit('mode:update', { mode: 'live' } satisfies ModeUpdate);
      console.log('[replay] Finished session');
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this._status.active = false;
    this._status.session = null;
  }

  getStatus(): ReplayStatus {
    return { ...this._status };
  }
}

async function emitSnapshot(snap: Snapshot, io: Server): Promise<void> {
  const byLine = new Map<string, LivePosition[]>();
  for (const v of snap.vehicles) {
    const arr = byLine.get(v.lineId) ?? [];
    arr.push(v);
    byLine.set(v.lineId, arr);
  }

  const pipeline = redis.pipeline();
  for (const v of snap.vehicles) {
    pipeline.set(`vehicle:${v.tripId}`, JSON.stringify(v), 'EX', 120);
  }
  await pipeline.exec();

  for (const [lineId, vehicles] of byLine) {
    io.to(`line:${lineId}`).emit('vehicles:update', vehicles);
  }
}

async function loadSnapshots(filePath: string): Promise<Snapshot[]> {
  return new Promise((resolve, reject) => {
    const snapshots: Snapshot[] = [];
    const rl = createInterface({ input: createReadStream(filePath) });
    rl.on('line', line => {
      if (line.trim()) snapshots.push(JSON.parse(line) as Snapshot);
    });
    rl.on('close', () => resolve(snapshots));
    rl.on('error', reject);
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export const replayController = new ReplayController();
