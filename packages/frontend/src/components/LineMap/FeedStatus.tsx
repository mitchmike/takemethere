import { useEffect, useRef, useState } from 'react';
import { socket } from '../../socket/client.js';

export function FeedStatus() {
  const lastUpdateAt  = useRef<number>(0);
  const lastStreamAt  = useRef<number>(0);
  const streamCount   = useRef(0);
  const [display, setDisplay] = useState<{ label: string; color: string; detail: string }>({
    label: 'Waiting', color: '#a1a1aa', detail: '—',
  });

  useEffect(() => {
    const onUpdate = () => { lastUpdateAt.current = Date.now(); };
    const onStream = () => { lastStreamAt.current = Date.now(); streamCount.current++; };
    socket.on('vehicles:update', onUpdate);
    socket.on('vehicles:stream', onStream);
    return () => { socket.off('vehicles:update', onUpdate); socket.off('vehicles:stream', onStream); };
  }, []);

  // Refresh the display every second
  useEffect(() => {
    const id = setInterval(() => {
      const now    = Date.now();
      const sinceUpdate = lastUpdateAt.current  ? Math.round((now - lastUpdateAt.current)  / 1000) : null;
      const sinceStream = lastStreamAt.current  ? Math.round((now - lastStreamAt.current)  / 1000) : null;

      const streaming = sinceStream !== null && sinceStream < 3;
      const pollAge   = sinceUpdate !== null
        ? (sinceUpdate < 60 ? `${sinceUpdate}s ago` : `${Math.round(sinceUpdate / 60)}m ago`)
        : '—';

      setDisplay({
        label:  streaming ? 'Live' : sinceUpdate !== null ? 'Stale' : 'Waiting',
        color:  streaming ? '#16a34a' : sinceUpdate !== null ? '#f59e0b' : '#a1a1aa',
        detail: sinceUpdate !== null ? `Poll ${pollAge}` : 'No poll yet',
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#71717a' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: display.color,
        boxShadow: display.color === '#16a34a' ? `0 0 6px ${display.color}` : 'none',
        flexShrink: 0,
      }} />
      <span style={{ color: display.color, fontWeight: 600 }}>{display.label}</span>
      <span>{display.detail}</span>
    </div>
  );
}
