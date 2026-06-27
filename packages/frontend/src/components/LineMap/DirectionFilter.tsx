import { useLinesStore } from '../../store/linesStore.js';

type Direction = 'inbound' | 'outbound' | 'both';

const OPTIONS: { value: Direction; label: string }[] = [
  { value: 'both', label: 'Both directions' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
];

const btn = (active: boolean): React.CSSProperties => ({
  padding: '3px 10px',
  fontSize: '0.78rem',
  fontWeight: 500,
  border: `1.5px solid ${active ? '#18181b' : '#d4d4d8'}`,
  borderRadius: '999px',
  background: active ? '#18181b' : 'transparent',
  color: active ? '#fff' : '#a1a1aa',
  cursor: 'pointer',
  transition: 'all 0.12s',
  lineHeight: '1.4',
});

export function DirectionFilter() {
  const direction = useLinesStore(s => s.directionFilter);
  const setDirection = useLinesStore(s => s.actions.setDirection);
  const orientation = useLinesStore(s => s.orientation);
  const setOrientation = useLinesStore(s => s.actions.setOrientation);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '0.78rem', color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '2px' }}>Direction</span>
        {OPTIONS.map(o => (
          <button key={o.value} style={btn(direction === o.value)} onClick={() => setDirection(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '0.78rem', color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '2px' }}>Layout</span>
        <button style={btn(orientation === 'horizontal')} onClick={() => setOrientation('horizontal')}>Horizontal</button>
        <button style={btn(orientation === 'vertical')} onClick={() => setOrientation('vertical')}>Vertical</button>
      </div>
    </div>
  );
}
