import { describe, it, expect, beforeEach } from 'vitest';
import { useLinesStore } from './linesStore.js';
import type { LineDefinition } from '@takemethere/shared';

function makeLine(lineId: string): LineDefinition {
  return { lineId, name: lineId, color: '#000', stops: [] };
}

const LINE_A = makeLine('belgrave');
const LINE_B = makeLine('lilydale');
const LINE_C = makeLine('alamein');

beforeEach(() => {
  // Reset store to initial state between tests
  useLinesStore.setState({
    lines: [],
    selectedLineIds: new Set(),
    directionFilter: 'both',
    orientation: 'horizontal',
  });
});

describe('linesStore', () => {
  describe('setLines', () => {
    it('replaces lines and selects all of them', () => {
      useLinesStore.getState().actions.setLines([LINE_A, LINE_B]);
      const { lines, selectedLineIds } = useLinesStore.getState();
      expect(lines).toHaveLength(2);
      expect(selectedLineIds.has('belgrave')).toBe(true);
      expect(selectedLineIds.has('lilydale')).toBe(true);
    });

    it('deselects lines that are no longer in the new set', () => {
      useLinesStore.getState().actions.setLines([LINE_A, LINE_B]);
      useLinesStore.getState().actions.setLines([LINE_C]);
      const { selectedLineIds } = useLinesStore.getState();
      expect(selectedLineIds.has('belgrave')).toBe(false);
      expect(selectedLineIds.has('lilydale')).toBe(false);
      expect(selectedLineIds.has('alamein')).toBe(true);
    });

    it('calling setLines with empty array clears selection', () => {
      useLinesStore.getState().actions.setLines([LINE_A]);
      useLinesStore.getState().actions.setLines([]);
      const { selectedLineIds } = useLinesStore.getState();
      expect(selectedLineIds.size).toBe(0);
    });
  });

  describe('toggleLine', () => {
    it('adds a line to selection when it was not selected', () => {
      useLinesStore.setState({ lines: [LINE_A, LINE_B], selectedLineIds: new Set(['belgrave']) });
      useLinesStore.getState().actions.toggleLine('lilydale');
      expect(useLinesStore.getState().selectedLineIds.has('lilydale')).toBe(true);
    });

    it('removes a line from selection when it was selected', () => {
      useLinesStore.setState({ lines: [LINE_A, LINE_B], selectedLineIds: new Set(['belgrave', 'lilydale']) });
      useLinesStore.getState().actions.toggleLine('belgrave');
      expect(useLinesStore.getState().selectedLineIds.has('belgrave')).toBe(false);
      expect(useLinesStore.getState().selectedLineIds.has('lilydale')).toBe(true);
    });

    it('does not mutate the previous selectedLineIds Set', () => {
      useLinesStore.setState({ lines: [LINE_A], selectedLineIds: new Set(['belgrave']) });
      const before = useLinesStore.getState().selectedLineIds;
      useLinesStore.getState().actions.toggleLine('belgrave');
      // The previous reference should be unchanged (immutable update)
      expect(before.has('belgrave')).toBe(true);
    });

    it('toggling an unknown lineId adds it', () => {
      useLinesStore.getState().actions.toggleLine('unknown');
      expect(useLinesStore.getState().selectedLineIds.has('unknown')).toBe(true);
    });
  });

  describe('setDirection', () => {
    it('defaults to both', () => {
      expect(useLinesStore.getState().directionFilter).toBe('both');
    });

    it('sets inbound', () => {
      useLinesStore.getState().actions.setDirection('inbound');
      expect(useLinesStore.getState().directionFilter).toBe('inbound');
    });

    it('sets outbound', () => {
      useLinesStore.getState().actions.setDirection('outbound');
      expect(useLinesStore.getState().directionFilter).toBe('outbound');
    });

    it('round-trips back to both', () => {
      useLinesStore.getState().actions.setDirection('inbound');
      useLinesStore.getState().actions.setDirection('both');
      expect(useLinesStore.getState().directionFilter).toBe('both');
    });
  });

  describe('setOrientation', () => {
    it('defaults to horizontal', () => {
      expect(useLinesStore.getState().orientation).toBe('horizontal');
    });

    it('switches to vertical', () => {
      useLinesStore.getState().actions.setOrientation('vertical');
      expect(useLinesStore.getState().orientation).toBe('vertical');
    });

    it('switches back to horizontal', () => {
      useLinesStore.getState().actions.setOrientation('vertical');
      useLinesStore.getState().actions.setOrientation('horizontal');
      expect(useLinesStore.getState().orientation).toBe('horizontal');
    });
  });
});
