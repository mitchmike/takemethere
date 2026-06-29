import { describe, it, expect } from 'vitest';
import { longNameToLineId, selectCanonicalShape } from '../../src/gtfs-static/shapes-loader.js';

// ─── longNameToLineId ─────────────────────────────────────────────────────────

describe('longNameToLineId', () => {
  it('maps standard "X - City" names to lineId', () => {
    expect(longNameToLineId('Alamein - City')).toBe('alamein');
    expect(longNameToLineId('Belgrave - City')).toBe('belgrave');
    expect(longNameToLineId('Frankston - City')).toBe('frankston');
    expect(longNameToLineId('Mernda - City')).toBe('mernda');
    expect(longNameToLineId('Upfield - City')).toBe('upfield');
  });

  it('maps hyphenated names correctly', () => {
    expect(longNameToLineId('Glen Waverley - City')).toBe('glen-waverley');
    expect(longNameToLineId('Craigieburn - City')).toBe('craigieburn');
    expect(longNameToLineId('Williamstown - City')).toBe('williamstown');
  });

  it('returns null for lines not in our system', () => {
    expect(longNameToLineId('Flemington Racecourse - City')).toBeNull();
    expect(longNameToLineId('Stony Point - Frankston')).toBeNull();
  });

  it('returns null for unknown names', () => {
    expect(longNameToLineId('Some Unknown Line')).toBeNull();
  });
});

// ─── selectCanonicalShape ─────────────────────────────────────────────────────

function makeFeature(headsign: string | null, coordCount: number) {
  return {
    properties: {
      MODE: 'METRO TRAIN', LONG_NAME: 'Alamein - City',
      SHORT_NAME: 'Alamein', HEADSIGN: headsign, SHAPE_ID: 'x',
    },
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: coordCount }, (_, i) => [145 + i * 0.001, -37.8] as [number, number]),
    },
  };
}

describe('selectCanonicalShape', () => {
  it('returns null for empty input', () => {
    expect(selectCanonicalShape([])).toBeNull();
  });

  it('prefers Flinders Street headsign over others', () => {
    const features = [
      makeFeature('Alamein', 400),
      makeFeature('Flinders Street via City Loop', 276),
      makeFeature('Riversdale', 163),
    ];
    const result = selectCanonicalShape(features);
    expect(result?.properties.HEADSIGN).toBe('Flinders Street via City Loop');
  });

  it('picks the largest coord count among Flinders Street headsigns', () => {
    const features = [
      makeFeature('Flinders Street', 300),
      makeFeature('Flinders Street via City Loop', 476),
      makeFeature('Alamein', 999),
    ];
    const result = selectCanonicalShape(features);
    expect(result?.geometry.coordinates.length).toBe(476);
    expect(result?.properties.HEADSIGN).toBe('Flinders Street via City Loop');
  });

  it('falls back to largest overall if no Flinders Street headsign', () => {
    const features = [
      makeFeature('Alamein', 200),
      makeFeature('Camberwell', 500),
      makeFeature('Riversdale', 100),
    ];
    const result = selectCanonicalShape(features);
    expect(result?.geometry.coordinates.length).toBe(500);
    expect(result?.properties.HEADSIGN).toBe('Camberwell');
  });

  it('handles a single feature', () => {
    const features = [makeFeature('Flinders Street', 238)];
    const result = selectCanonicalShape(features);
    expect(result?.geometry.coordinates.length).toBe(238);
  });

  it('handles null headsigns without crashing', () => {
    const features = [
      makeFeature(null, 200),
      makeFeature('Flinders Street', 150),
    ];
    const result = selectCanonicalShape(features);
    expect(result?.properties.HEADSIGN).toBe('Flinders Street');
  });
});
