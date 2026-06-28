import { useRef, useEffect, useState } from 'react';
import type { LivePosition, StreamedPosition, UpcomingStop, LineDefinition } from '@takemethere/shared';
import { socket } from '../../socket/client.js';
import { useLinesStore } from '../../store/linesStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useTrainsStore } from '../../store/trainsStore.js';

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function melbTime(epoch: number): string {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function secsLabel(epoch: number): string {
  if (!epoch) return '—';
  const secs = Math.round(epoch - Date.now() / 1000);
  if (secs <= 0) return `arriving (${melbTime(epoch)})`;
  return `${secs}s (${melbTime(epoch)})`;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px' }}>
      <span style={{ color: '#71717a', flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#18181b', fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', color: '#71717a', fontWeight: 600, marginTop: '6px', marginBottom: '2px' }}>
      {children}
    </div>
  );
}

interface LiveDisplayProps {
  position: LivePosition;
  lineColor: string;
  line: LineDefinition | undefined;
}

function LiveDisplay({ position, lineColor, line }: LiveDisplayProps) {
  // Raw stream data for this trip — updates at ~1Hz from vehicles:stream
  const [stream, setStream] = useState<StreamedPosition | null>(null);
  // Countdown ticker — updates every second so ETA labels stay accurate
  const [, setTick] = useState(0);

  // Subscribe to raw stream data
  useEffect(() => {
    function onStream(updates: StreamedPosition[]) {
      const u = updates.find(x => x.tripId === position.tripId);
      if (!u) return;
      setStream(u);
      // Console log every stream tick so we can see what the backend is sending
      console.log('[stream]', new Date().toLocaleTimeString('en-AU', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }), u.tripId, {
        cx:        u.canonicalX.toFixed(4),
        segment:   `${u.prevStopName?.replace(/ Station$/, '') ?? '?'} → ${u.nextStopName?.replace(/ Station$/, '') ?? '?'}`,
        atStation: u.atStation,
        adjETA:    u.nextArrivalEpoch    ? secsLabel(u.nextArrivalEpoch)           : '—',
        predETA:   u.predictedNextArrivalEpoch ? secsLabel(u.predictedNextArrivalEpoch) : '—',
        speedKmh:  u.segmentSpeedKmh?.toFixed(1) ?? null,
      });
    }
    socket.on('vehicles:stream', onStream);
    return () => { socket.off('vehicles:stream', onStream); };
  }, [position.tripId]);

  // Log each new GPS snapshot from the poll
  const lastLoggedTimestamp = useRef(0);
  useEffect(() => {
    if (position.timestamp === lastLoggedTimestamp.current) return;
    lastLoggedTimestamp.current = position.timestamp;
    const nowEpoch = Date.now() / 1000;
    console.log('[snapshot]', position.tripId, {
      segment:   `${position.prevStopName ?? '?'} → ${position.nextStopName ?? '?'}`,
      canonicalX: position.canonicalX.toFixed(4),
      gpsAge:    `${Math.round(nowEpoch - position.timestamp)}s`,
      delay:     position.delay,
      scheduled: melbTime(position.scheduledNextArrivalEpoch),
      adjusted:  melbTime(position.nextArrivalEpoch),
      predicted: melbTime(position.predictedNextArrivalEpoch),
      speedKmh:  position.segmentSpeedKmh?.toFixed(1) ?? null,
    });
  }, [position]);

  // Tick once per second for countdown labels
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const delayLabel =
    position.delay === 0 ? 'On time' :
    position.delay > 0   ? `+${position.delay}s late` : `${Math.abs(position.delay)}s early`;

  const directionLabel =
    position.directionId === 0 ? 'Outbound' :
    position.directionId === 1 ? 'Inbound'  : '—';

  // Prefer stream data when available (1Hz); fall back to poll snapshot
  const prevName = (stream?.prevStopName ?? position.prevStopName)?.replace(/ Station$/, '') ?? '—';
  const nextName = (stream?.nextStopName ?? position.nextStopName)?.replace(/ Station$/, '') ?? '—';
  const cx                = stream?.canonicalX ?? position.canonicalX;
  const prevStopCanonicalX = stream?.prevStopCanonicalX ?? position.prevStopCanonicalX;
  const nextStopCanonicalX = stream?.nextStopCanonicalX ?? position.nextStopCanonicalX;
  const adjEta   = stream?.nextArrivalEpoch          ?? position.nextArrivalEpoch;
  const predEta  = stream?.predictedNextArrivalEpoch ?? position.predictedNextArrivalEpoch;
  const schedEta = stream?.scheduledNextArrivalEpoch ?? position.scheduledNextArrivalEpoch;
  const speed    = stream?.segmentSpeedKmh           ?? position.segmentSpeedKmh;
  const atStation = stream?.atStation ?? false;

  // Line-relative percentage: normalise canonicalX to [0,1] within this line's extent
  const lineMinCx = line ? Math.min(...line.stops.map(s => s.canonicalX)) : 0;
  const lineMaxCx = line ? Math.max(...line.stops.map(s => s.canonicalX)) : 1;
  const linePct   = lineMaxCx > lineMinCx ? (cx - lineMinCx) / (lineMaxCx - lineMinCx) : cx;

  // Metres within current segment
  const prevStopEntry = line?.stops.find(s => s.stopName === (stream?.prevStopName ?? position.prevStopName));
  const nextStopEntry = line?.stops.find(s => s.stopName === (stream?.nextStopName ?? position.nextStopName));
  let distFromPrevM: number | null = null;
  let distToNextM:   number | null = null;
  if (prevStopEntry && nextStopEntry && Math.abs(nextStopCanonicalX - prevStopCanonicalX) > 0.002) {
    const segDistM  = haversineM(prevStopEntry.stopLat, prevStopEntry.stopLon, nextStopEntry.stopLat, nextStopEntry.stopLon);
    const segFrac   = (cx - prevStopCanonicalX) / (nextStopCanonicalX - prevStopCanonicalX);
    const clampFrac = Math.max(0, Math.min(1, segFrac));
    distFromPrevM = Math.round(clampFrac * segDistM);
    distToNextM   = Math.round((1 - clampFrac) * segDistM);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Segment */}
      <div style={{ fontSize: '12px', color: '#52525b', textAlign: 'center', marginBottom: '2px' }}>
        <span style={{ color: '#a1a1aa' }}>{prevName}</span>
        <span style={{ margin: '0 6px', color: lineColor }}>→</span>
        <span style={{ fontWeight: 600, color: '#18181b' }}>{nextName}</span>
      </div>

      {/* Position — line-relative % */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px' }}>
        <span style={{ color: '#71717a', flexShrink: 0 }}>
          {stream ? 'Position' : 'Position (GPS)'}
        </span>
        <span style={{ color: lineColor, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {(linePct * 100).toFixed(1)}%
          {!stream && <span style={{ color: '#a1a1aa', fontSize: '11px', marginLeft: '4px' }}>(no stream)</span>}
        </span>
      </div>

      {/* Metres within segment */}
      {distFromPrevM !== null && distToNextM !== null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '12px', color: '#52525b' }}>
          <span>{distFromPrevM >= 1000 ? `${(distFromPrevM / 1000).toFixed(1)} km` : `${distFromPrevM} m`} from {prevName}</span>
          <span style={{ textAlign: 'right' }}>{distToNextM >= 1000 ? `${(distToNextM / 1000).toFixed(1)} km` : `${distToNextM} m`} to {nextName}</span>
        </div>
      )}

      {atStation && (
        <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 600, textAlign: 'center' }}>
          ⏸ At station
        </div>
      )}

      {/* ETAs */}
      <InfoRow label="Scheduled">{melbTime(schedEta)}</InfoRow>
      <InfoRow label="Adjusted ETA">{adjEta ? secsLabel(adjEta) : '—'}</InfoRow>
      <InfoRow label="Predicted ETA">{predEta ? secsLabel(predEta) : '—'}</InfoRow>

      <InfoRow label="Direction">{directionLabel}</InfoRow>
      <InfoRow label="Delay">{delayLabel}</InfoRow>
      {speed != null && (
        <InfoRow label="Segment speed">{speed.toFixed(0)} km/h</InfoRow>
      )}

      {/* Stream health */}
      <SectionLabel>STREAM</SectionLabel>
      <InfoRow label="Source">{stream ? 'Live (backend)' : 'Poll snapshot only'}</InfoRow>
      {stream && (
        <InfoRow label="At station">{stream.atStation ? 'Yes' : 'No'}</InfoRow>
      )}

      {/* Upcoming stops */}
      {position.upcomingStops.length > 0 && (
        <UpcomingStopsTable stops={position.upcomingStops} lineColor={lineColor} />
      )}

      <InfoRow label="Trip ID">
        <span style={{ fontSize: '11px', fontFamily: 'monospace' }}>{position.tripId}</span>
      </InfoRow>
    </div>
  );
}

function UpcomingStopsTable({ stops, lineColor }: { stops: UpcomingStop[]; lineColor: string }) {
  return (
    <div style={{ marginTop: '4px' }}>
      <SectionLabel>UPCOMING STOPS</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {stops.slice(0, 8).map(s => {
          const name = s.stopName.replace(/ Station$/, '');
          const hasDelay = s.tuDelaySeconds != null && Math.abs(s.tuDelaySeconds) >= 30;
          const delayStr = hasDelay
            ? (s.tuDelaySeconds! > 0 ? `+${Math.round(s.tuDelaySeconds! / 60)}m` : `-${Math.round(Math.abs(s.tuDelaySeconds!) / 60)}m`)
            : null;
          return (
            <div key={s.stopId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px' }}>
                {name}
              </span>
              <span style={{ color: '#52525b', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', marginLeft: '8px' }}>
                {melbTime(s.adjustedArrivalEpoch)}
                {delayStr && <span style={{ color: lineColor, marginLeft: '4px', fontSize: '10px' }}>{delayStr}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export function TrainInfoPanel() {
  const selectedTripId = useUiStore(s => s.selectedTripId);
  const selectTrip     = useUiStore(s => s.actions.selectTrip);
  const position       = useTrainsStore(s => selectedTripId ? s.positions.get(selectedTripId) : undefined);
  const lines          = useLinesStore(s => s.lines);

  if (!selectedTripId || !position) return null;

  const line      = lines.find(l => l.lineId === position.lineId);
  const lineColor = line?.color ?? '#374151';

  return (
    <div style={{
      background: '#fff',
      border: `2px solid ${lineColor}`,
      borderRadius: '10px',
      padding: '14px 16px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
      minWidth: '240px',
      maxWidth: '280px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: lineColor }} />
          <span style={{ fontWeight: 700, fontSize: '14px', color: lineColor }}>
            {line?.name ?? position.lineId}
          </span>
        </div>
        <button
          onClick={() => selectTrip(null)}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: '#a1a1aa', fontSize: '16px', lineHeight: 1, padding: '0 2px',
          }}
        >×</button>
      </div>

      <LiveDisplay position={position} lineColor={lineColor} line={line} />
    </div>
  );
}
