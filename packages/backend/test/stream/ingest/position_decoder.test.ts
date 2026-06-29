import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeFeed, extractVehiclePositions, extractTripUpdates } from '../../../src/stream/ingest/position_decoder.js';
import type { transit_realtime } from 'gtfs-realtime-bindings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../fixtures');

const vpBuf = fs.readFileSync(path.join(FIXTURES, 'vehicle-positions.pb'));
const tuBuf = fs.readFileSync(path.join(FIXTURES, 'trip-updates.pb'));

describe('decodeFeed', () => {
  it('decodes VP feed without throwing', () => {
    expect(() => decodeFeed(vpBuf)).not.toThrow();
  });

  it('decodes TU feed without throwing', () => {
    expect(() => decodeFeed(tuBuf)).not.toThrow();
  });

  it('VP feed has entities', () => {
    const feed = decodeFeed(vpBuf);
    expect(feed.entity.length).toBeGreaterThan(0);
  });
});

describe('extractVehiclePositions', () => {
  const feed = decodeFeed(vpBuf);
  const vehicles = extractVehiclePositions(feed);

  it('returns an array of vehicle positions', () => {
    expect(vehicles.length).toBeGreaterThan(0);
  });

  it('every position has a valid lat/lon', () => {
    for (const v of vehicles) {
      expect(v.lat).toBeGreaterThan(-90);
      expect(v.lat).toBeLessThan(90);
      expect(v.lon).toBeGreaterThan(-180);
      expect(v.lon).toBeLessThan(180);
    }
  });

  it('every position has a tripId string', () => {
    for (const v of vehicles) {
      expect(typeof v.tripId).toBe('string');
      expect(v.tripId!.length).toBeGreaterThan(0);
    }
  });

  it('every position has a numeric timestamp', () => {
    for (const v of vehicles) {
      expect(typeof v.timestamp).toBe('number');
      expect(v.timestamp).toBeGreaterThan(0);
    }
  });

  it('all positions are in Melbourne area', () => {
    for (const v of vehicles) {
      expect(v.lat).toBeGreaterThan(-38.5);
      expect(v.lat).toBeLessThan(-37.4);
      expect(v.lon).toBeGreaterThan(144.5);
      expect(v.lon).toBeLessThan(145.6);
    }
  });
});

describe('extractTripUpdates', () => {
  const feed = decodeFeed(tuBuf);
  const updates = extractTripUpdates(feed);

  it('returns a non-empty map', () => {
    expect(updates.size).toBeGreaterThan(0);
  });

  it('every entry has a tripId key matching its value', () => {
    for (const [tripId, entry] of updates) {
      expect(entry.tripId).toBe(tripId);
    }
  });

  it('delay is always a number', () => {
    for (const entry of updates.values()) {
      expect(typeof entry.delay).toBe('number');
    }
  });

  it('entries with nextStopId have a positive nextArrivalEpoch or 0', () => {
    for (const entry of updates.values()) {
      expect(entry.nextArrivalEpoch).toBeGreaterThanOrEqual(0);
    }
  });

  it('when all stop updates are in the past, uses the last (terminal) stop — not the first', () => {
    // Build a synthetic feed where all stop arrival times are in the past.
    // Bug would be: nextStopId = first stop (hours ago); Fix: nextStopId = last stop (terminal).
    const pastBase = Math.floor(Date.now() / 1000) - 3600;
    const feed = {
      entity: [{
        tripUpdate: {
          trip: { tripId: 'trip-past', routeId: 'r1' },
          stopTimeUpdate: [
            { stopId: 'stop-1', stopSequence: 1, arrival: { time: pastBase - 600, delay: 0 }, departure: null },
            { stopId: 'stop-2', stopSequence: 2, arrival: { time: pastBase - 300, delay: 0 }, departure: null },
            { stopId: 'stop-terminus', stopSequence: 3, arrival: { time: pastBase, delay: 0 }, departure: null },
          ],
        },
      }],
    } as unknown as transit_realtime.FeedMessage;

    const updates = extractTripUpdates(feed);
    const entry = updates.get('trip-past');
    expect(entry).toBeDefined();
    expect(entry!.nextStopId).toBe('stop-terminus');
    expect(entry!.nextArrivalEpoch).toBe(pastBase);
  });

  it('VP entries have high TU match rate (>= 80%)', () => {
    const vpFeed = decodeFeed(vpBuf);
    const vehicles = extractVehiclePositions(vpFeed);
    const matched = vehicles.filter(v => v.tripId && updates.has(v.tripId)).length;
    const rate = matched / vehicles.length;
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});
