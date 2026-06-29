import { useEffect } from 'react';
import { Header } from './components/Header/Header.js';
import { LineMap } from './components/LineMap/LineMap.js';
import { ReplayBanner } from './components/ReplayBanner/ReplayBanner.js';
import { useLinesStore } from './store/linesStore.js';
import { useReplayMode } from './socket/hooks.js';

export default function App() {
  const setLines = useLinesStore(s => s.actions.setLines);
  useReplayMode();

  useEffect(() => {
    fetch('/api/lines')
      .then(r => r.json())
      .then(data => setLines(data.lines))
      .catch(console.error);
  }, [setLines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header />
      <ReplayBanner />
      <main style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        <LineMap />
      </main>
    </div>
  );
}
