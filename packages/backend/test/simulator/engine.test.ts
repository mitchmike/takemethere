import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshots, listTrips, simulateTrip } from '../../src/simulator/engine.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, '../../data/sim-captures');

// From script.ts: mae >= 0.06 is "Poor accuracy" — that's the gating threshold.
// accuracyPct is not asserted: it counts intervals within ±0.02 and is misleading
// for short or sparse trips. MAE is the authoritative quality metric.
const MAE_FAIL_THRESHOLD = 0.06;

function loadSessions(): string[] {
  try {
    return readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

const sessions = loadSessions();

describe('simulator engine accuracy', () => {
  it.skipIf(sessions.length === 0)('all recorded sessions meet minimum accuracy thresholds', () => {
    for (const sessionFile of sessions) {
      const raw = readFileSync(join(DATA_DIR, sessionFile), 'utf8');
      const snapshots = parseSnapshots(raw);
      expect(snapshots.length, `${sessionFile}: fewer than 2 snapshots`).toBeGreaterThanOrEqual(2);

      const trips = listTrips(snapshots).filter(t => t.snapshotCount >= 2);
      expect(trips.length, `${sessionFile}: no simulatable trips (all appeared in <2 snapshots)`).toBeGreaterThan(0);

      for (const { tripId } of trips) {
        const result = simulateTrip(snapshots, tripId);
        expect(result, `${sessionFile} trip ${tripId}: simulateTrip returned null`).not.toBeNull();

        expect(
          result!.mae,
          `${sessionFile} trip ${tripId}: MAE ${result!.mae.toFixed(3)} exceeds poor-accuracy threshold ${MAE_FAIL_THRESHOLD}`,
        ).toBeLessThan(MAE_FAIL_THRESHOLD);


      }
    }
  });

  it.skipIf(sessions.length === 0)('simulateTrip returns null for unknown tripId', () => {
    const raw = readFileSync(join(DATA_DIR, sessions[0]), 'utf8');
    const snapshots = parseSnapshots(raw);
    expect(simulateTrip(snapshots, '__nonexistent_trip__')).toBeNull();
  });
});
