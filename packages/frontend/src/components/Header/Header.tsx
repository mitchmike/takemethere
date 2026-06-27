import { LiveClock } from './LiveClock.js';

export function Header() {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 24px',
      background: '#fff',
      borderBottom: '1px solid #e4e4e7',
      flexShrink: 0,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      <span style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '0.02em', color: '#18181b' }}>
        TakeMeThere
      </span>
      <LiveClock />
    </header>
  );
}
