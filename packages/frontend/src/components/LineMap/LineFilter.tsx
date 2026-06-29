import { useMemo } from 'react';
import { useLinesStore } from '../../store/linesStore.js';
import { REGION_ORDER, LINE_MAP } from '@takemethere/shared';

const chip = (active: boolean, color?: string): React.CSSProperties => ({
  padding: '3px 10px',
  fontSize: '0.78rem',
  fontWeight: 500,
  border: `1.5px solid ${active ? (color ?? '#18181b') : '#d4d4d8'}`,
  borderRadius: '999px',
  background: active ? (color ? color + '18' : '#f4f4f5') : 'transparent',
  color: active ? (color ?? '#18181b') : '#a1a1aa',
  cursor: 'pointer',
  transition: 'all 0.12s',
  lineHeight: '1.4',
  whiteSpace: 'nowrap',
});

export function LineFilter() {
  const lines = useLinesStore(s => s.lines);
  const selectedLineIds = useLinesStore(s => s.selectedLineIds);
  const toggleLine = useLinesStore(s => s.actions.toggleLine);
  const selectAll = useLinesStore(s => s.actions.selectAll);
  const clearAll = useLinesStore(s => s.actions.clearAll);

  const allSelected = selectedLineIds.size === lines.length;
  const noneSelected = selectedLineIds.size === 0;

  const byRegion = useMemo(() => {
    const map = new Map<string, typeof lines>();
    for (const region of REGION_ORDER) map.set(region, []);
    for (const line of lines) {
      const cfg = LINE_MAP.get(line.lineId);
      const region = cfg?.region ?? 'Other';
      if (!map.has(region)) map.set(region, []);
      map.get(region)!.push(line);
    }
    return map;
  }, [lines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '0.78rem', color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lines</span>
        <button style={chip(allSelected)} onClick={selectAll}>All</button>
        <button style={chip(noneSelected)} onClick={clearAll}>None</button>
      </div>
      {Array.from(byRegion.entries()).filter(([, ls]) => ls.length > 0).map(([region, ls]) => (
        <div key={region} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '0.72rem', color: '#a1a1aa', width: '88px', flexShrink: 0 }}>{region}</span>
          {ls.map(line => (
            <button
              key={line.lineId}
              style={chip(selectedLineIds.has(line.lineId), line.color)}
              onClick={() => toggleLine(line.lineId)}
            >
              {line.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
