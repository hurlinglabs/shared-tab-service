import { useCallback, useEffect, useRef, useState } from 'react';
import { client, currentMode, tabId } from './client.js';

const BASE_TITLE = 'Shared Tab Service — React Demo';
const MODE_CHANNEL = 'vite-react-demo-mode';

interface LogEntry {
  id: number;
  time: string;
  text: string;
}

function switchMode(next: 'shared' | 'tab'): void {
  if (next === currentMode) return;
  location.href = `?mode=${next}`;
}

export function App() {
  const [count, setCount] = useState<number | null>(null);
  const [isLeader, setIsLeader] = useState(client.isLeader);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextLogId = useRef(0);

  const addLog = useCallback((text: string) => {
    setLog((prev) =>
      [{ id: nextLogId.current++, time: new Date().toLocaleTimeString(), text }, ...prev].slice(
        0,
        50,
      ),
    );
  }, []);

  useEffect(() => {
    let active = true;
    void client.counter.get().then((value) => {
      if (active) setCount(value);
    });
    const unsubscribe = client.counter.on('changed', ({ value, byTab }) => {
      setCount(value);
      addLog(`counter → ${value} (by ${byTab === tabId ? 'this tab' : byTab})`);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [addLog]);

  useEffect(() => {
    const sync = () => setIsLeader(client.isLeader);
    const unsubscribe = client.onLeaderChange(setIsLeader);
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  useEffect(() => {
    document.title = isLeader ? `★ Leader — ${BASE_TITLE}` : BASE_TITLE;
  }, [isLeader]);

  useEffect(() => {
    const channel = new BroadcastChannel(MODE_CHANNEL);
    const handler = (event: MessageEvent<'shared' | 'tab'>) => switchMode(event.data);
    channel.addEventListener('message', handler);
    return () => {
      channel.removeEventListener('message', handler);
      channel.close();
    };
  }, []);

  const handleModeClick = (next: 'shared' | 'tab') => {
    if (next === currentMode) return;
    const channel = new BroadcastChannel(MODE_CHANNEL);
    channel.postMessage(next);
    channel.close();
    switchMode(next);
  };

  const leaderLabel = isLeader ? 'this tab' : currentMode === 'shared' ? 'worker' : 'another tab';

  return (
    <main>
      <header>
        <h1>{BASE_TITLE}</h1>
        <p className="hint">Open this page in multiple tabs — counter and events are shared.</p>
      </header>

      <section className="info">
        <div>
          <span>Tab ID</span>
          <code>{tabId}</code>
        </div>
        <div>
          <span>Mode</span>
          <code>
            {currentMode === 'shared'
              ? 'SharedWorker (falls back to tab-election)'
              : 'Tab-election (forced)'}
          </code>
          <span className="mode-links">
            <button
              type="button"
              className={currentMode === 'shared' ? 'active' : ''}
              onClick={() => handleModeClick('shared')}
            >
              SharedWorker
            </button>
            {' · '}
            <button
              type="button"
              className={currentMode === 'tab' ? 'active' : ''}
              onClick={() => handleModeClick('tab')}
            >
              Tab-election
            </button>
          </span>
        </div>
        <div>
          <span>Leader</span>
          <code>{leaderLabel}</code>
        </div>
      </section>

      <section className="counter">
        <h2>
          Counter: <span>{count ?? '…'}</span>
        </h2>
        <button type="button" onClick={() => void client.counter.increment(tabId)}>
          Increment
        </button>
      </section>

      <section className="log">
        <h3>Events</h3>
        <ul>
          {log.map((entry) => (
            <li key={entry.id}>
              {entry.time} — {entry.text}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
