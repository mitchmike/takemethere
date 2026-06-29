import { useReplayStore } from '../../store/replayStore.js';

export function ReplayBanner() {
  const replay = useReplayStore(s => s.replay);

  if (replay.mode !== 'replay') return null;

  const pct = replay.totalSnapshots > 0
    ? Math.round((replay.snapshotIndex / replay.totalSnapshots) * 100)
    : 0;

  const timeLabel = replay.capturedAt
    ? new Date(replay.capturedAt).toLocaleTimeString()
    : null;

  return (
    <div style={{
      background: '#92400e',
      color: '#fef3c7',
      padding: '6px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      fontSize: '0.82rem',
      fontWeight: 500,
      flexShrink: 0,
    }}>
      <span style={{ color: '#fbbf24', fontWeight: 700, letterSpacing: '0.04em' }}>
        ▶ REPLAY
      </span>
      <span>{replay.session}</span>
      {timeLabel && <span style={{ color: '#d97706' }}>captured {timeLabel}</span>}
      <span style={{ color: '#d97706' }}>
        {replay.snapshotIndex + 1} / {replay.totalSnapshots}
      </span>
      <span style={{ color: '#d97706' }}>{replay.speed}×</span>
      <div style={{
        flex: 1,
        height: '4px',
        background: '#78350f',
        borderRadius: '2px',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: '#fbbf24',
          borderRadius: '2px',
          transition: 'width 0.5s ease',
        }} />
      </div>
      <span style={{ color: '#d97706', minWidth: '2.5rem', textAlign: 'right' }}>
        {pct}%
      </span>
    </div>
  );
}
