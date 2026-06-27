import { LiveClock } from './LiveClock.js';

export function Header() {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 20px',
      background: '#1a1a1a',
      borderBottom: '1px solid #333',
      flexShrink: 0,
    }}>
      <span style={{ fontWeight: 700, fontSize: '1.2rem', letterSpacing: '0.05em' }}>
        TakeMeThere
      </span>
      <LiveClock />
    </header>
  );
}
