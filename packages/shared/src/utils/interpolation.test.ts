import { describe, it, expect } from 'vitest';
import { clamp, lerp, deadReckonFraction, reconcileFraction } from './interpolation.js';

describe('clamp', () => {
  it('returns value when within range', () => expect(clamp(0.5, 0, 1)).toBe(0.5));
  it('clamps to min', () => expect(clamp(-0.1, 0, 1)).toBe(0));
  it('clamps to max', () => expect(clamp(1.5, 0, 1)).toBe(1));
});

describe('lerp', () => {
  it('returns a at t=0', () => expect(lerp(0, 10, 0)).toBe(0));
  it('returns b at t=1', () => expect(lerp(0, 10, 1)).toBe(10));
  it('returns midpoint at t=0.5', () => expect(lerp(0, 10, 0.5)).toBe(5));
});

describe('deadReckonFraction', () => {
  const departure = 1000;
  const arrival = 3000;

  it('advances fraction based on elapsed time', () => {
    // Segment is 2000ms. Started at fraction 0, 1000ms elapsed → should be 0.5
    const result = deadReckonFraction(0, departure, departure, arrival, departure + 1000);
    expect(result).toBeCloseTo(0.5);
  });

  it('clamps to 1 when overdue', () => {
    const result = deadReckonFraction(0.5, departure, departure, arrival, departure + 9999);
    expect(result).toBe(1);
  });

  it('handles zero-duration segment gracefully', () => {
    const result = deadReckonFraction(0.3, 1000, 1000, 1000, 2000);
    expect(result).toBe(0.3);
  });
});

describe('reconcileFraction', () => {
  it('returns animated fraction at t=0', () => {
    expect(reconcileFraction(0.2, 0.8, 0, 3000)).toBeCloseTo(0.2);
  });

  it('returns truth fraction at t=1', () => {
    expect(reconcileFraction(0.2, 0.8, 3000, 3000)).toBeCloseTo(0.8);
  });

  it('interpolates at midpoint', () => {
    expect(reconcileFraction(0, 1, 1500, 3000)).toBeCloseTo(0.5);
  });
});
