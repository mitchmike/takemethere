import { useLinesStore } from '../../store/linesStore.js';

export function LineFilter() {
  const lines = useLinesStore(s => s.lines);
  const selectedLineIds = useLinesStore(s => s.selectedLineIds);
  const toggleLine = useLinesStore(s => s.actions.toggleLine);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
      {lines.map(line => (
        <label
          key={line.lineId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            cursor: 'pointer',
            opacity: selectedLineIds.has(line.lineId) ? 1 : 0.4,
            fontSize: '0.85rem',
          }}
        >
          <input
            type="checkbox"
            checked={selectedLineIds.has(line.lineId)}
            onChange={() => toggleLine(line.lineId)}
            style={{ accentColor: line.color }}
          />
          <span style={{ color: line.color }}>{line.name}</span>
        </label>
      ))}
    </div>
  );
}
