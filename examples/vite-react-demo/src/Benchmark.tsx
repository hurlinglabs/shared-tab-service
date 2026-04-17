import { useState } from 'react';
import { client, tabId } from './client.js';

interface BenchResult {
  mode: 'parallel' | 'sequential';
  n: number;
  elapsedMs: number;
  opsPerSec: number;
  msPerCall: number;
  finalCounter: number;
}

export function Benchmark() {
  const [n, setN] = useState(1000);
  const [running, setRunning] = useState<null | 'parallel' | 'sequential'>(null);
  const [result, setResult] = useState<BenchResult | null>(null);

  const run = async (mode: 'parallel' | 'sequential') => {
    setRunning(mode);
    setResult(null);
    const start = performance.now();
    if (mode === 'parallel') {
      await Promise.all(Array.from({ length: n }, () => client.counter.increment(tabId)));
    } else {
      for (let i = 0; i < n; i += 1) await client.counter.increment(tabId);
    }
    const elapsedMs = performance.now() - start;
    const finalCounter = await client.counter.get();
    setResult({
      mode,
      n,
      elapsedMs,
      opsPerSec: n / (elapsedMs / 1000),
      msPerCall: elapsedMs / n,
      finalCounter,
    });
    setRunning(null);
  };

  return (
    <section className="bench">
      <h3>Load test</h3>
      <div className="bench-controls">
        <label>
          N
          <input
            type="number"
            min={1}
            max={100000}
            step={100}
            value={n}
            onChange={(e) => setN(Math.max(1, Number(e.target.value) || 0))}
            disabled={running !== null}
          />
        </label>
        <button type="button" onClick={() => void run('parallel')} disabled={running !== null}>
          {running === 'parallel' ? 'Running…' : 'Run parallel'}
        </button>
        <button type="button" onClick={() => void run('sequential')} disabled={running !== null}>
          {running === 'sequential' ? 'Running…' : 'Run sequential'}
        </button>
      </div>
      {result && (
        <dl className="bench-result">
          <div>
            <dt>Mode</dt>
            <dd>
              {result.mode} × {result.n}
            </dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{result.elapsedMs.toFixed(1)} ms</dd>
          </div>
          <div>
            <dt>Throughput</dt>
            <dd>{Math.round(result.opsPerSec).toLocaleString()} ops/s</dd>
          </div>
          <div>
            <dt>Per call</dt>
            <dd>{result.msPerCall.toFixed(3)} ms</dd>
          </div>
          <div>
            <dt>Final counter</dt>
            <dd>{result.finalCounter.toLocaleString()}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
