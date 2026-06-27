import { useLinesStore } from '../../store/linesStore.js';

type Direction = 'inbound' | 'outbound' | 'both';

const OPTIONS: { value: Direction; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
];

export function DirectionFilter() {
  const direction = useLinesStore(s => s.directionFilter);
  const setDirection = useLinesStore(s => s.actions.setDirection);
  const orientation = useLinesStore(s => s.orientation);
  const setOrientation = useLinesStore(s => s.actions.setOrientation);

  return (
    <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {OPTIONS.map(o => (
          <button
            key={o.value}
            onClick={() => setDirection(o.value)}
            style={{
              padding: '4px 10px',
              fontSize: '0.8rem',
              border: '1px solid #444',
              borderRadius: '4px',
              background: direction === o.value ? '#333' : 'transparent',
              color: direction === o.value ? '#fff' : '#888',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => setOrientation(orientation === 'horizontal' ? 'vertical' : 'horizontal')}
        style={{
          padding: '4px 10px',
          fontSize: '0.8rem',
          border: '1px solid #444',
          borderRadius: '4px',
          background: 'transparent',
          color: '#888',
          cursor: 'pointer',
        }}
      >
        {orientation === 'horizontal' ? '↕ Vertical' : '↔ Horizontal'}
      </button>
    </div>
  );
}
