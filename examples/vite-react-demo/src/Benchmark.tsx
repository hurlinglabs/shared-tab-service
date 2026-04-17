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

const COLORS: Record<BenchResult['mode'], string> = {
  parallel: '#3b82f6',
  sequential: '#f59e0b',
};

export function Benchmark() {
  const [n, setN] = useState(1000);
  const [running, setRunning] = useState<null | 'parallel' | 'sequential'>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [samples, setSamples] = useState<BenchResult[]>([]);

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
    const next: BenchResult = {
      mode,
      n,
      elapsedMs,
      opsPerSec: n / (elapsedMs / 1000),
      msPerCall: elapsedMs / n,
      finalCounter,
    };
    setResult(next);
    setSamples((prev) => [...prev, next]);
    setRunning(null);
  };

  return (
    <section className="bench">
      <h3>Load test</h3>
      <p className="hint">
        <strong>Parallel</strong> fires all N calls in the same tick — the library's transparent
        batching coalesces them into a single RPC round trip, so you see the true throughput
        ceiling. <strong>Sequential</strong> awaits each call's reply before sending the next, so
        every call pays a full round-trip latency — useful for measuring benchmark where full round
        trip/sequencial workloads.
      </p>
      <div className="bench-controls">
        <label>
          N
          <input
            type="number"
            min={1}
            max={10000}
            step={100}
            value={n}
            onChange={(e) => setN(Math.min(10000, Math.max(1, Number(e.target.value) || 0)))}
            disabled={running !== null}
          />
        </label>
        <button type="button" onClick={() => void run('parallel')} disabled={running !== null}>
          {running === 'parallel' ? 'Running…' : 'Run parallel'}
        </button>
        <button type="button" onClick={() => void run('sequential')} disabled={running !== null}>
          {running === 'sequential' ? 'Running…' : 'Run sequential'}
        </button>
        {samples.length > 0 && (
          <button
            type="button"
            onClick={() => setSamples([])}
            disabled={running !== null}
            className="bench-clear"
          >
            Clear samples ({samples.length})
          </button>
        )}
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
      {samples.length > 0 && <BenchChart samples={samples} />}
    </section>
  );
}

interface BenchChartProps {
  samples: BenchResult[];
}

function BenchChart({ samples }: BenchChartProps) {
  const width = 640;
  const height = 280;
  const pad = { top: 12, right: 16, bottom: 36, left: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxN = Math.max(...samples.map((s) => s.n), 1);
  const maxOps = Math.max(...samples.map((s) => s.opsPerSec), 1);

  const sx = (n: number) => pad.left + (n / maxN) * plotW;
  const sy = (ops: number) => pad.top + plotH - (ops / maxOps) * plotH;

  const ticksX = niceTicks(0, maxN, 5);
  const ticksY = niceTicks(0, maxOps, 5);

  return (
    <div className="bench-chart-wrap">
      <svg
        className="bench-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Throughput vs N"
      >
        {ticksY.map((t) => (
          <g key={`gy-${t}`}>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={sy(t)}
              y2={sy(t)}
              className="bench-chart-grid"
            />
            <text
              x={pad.left - 8}
              y={sy(t)}
              dy="0.32em"
              textAnchor="end"
              className="bench-chart-tick"
            >
              {formatOps(t)}
            </text>
          </g>
        ))}
        {ticksX.map((t) => (
          <g key={`gx-${t}`}>
            <line
              x1={sx(t)}
              x2={sx(t)}
              y1={pad.top}
              y2={pad.top + plotH}
              className="bench-chart-grid"
            />
            <text
              x={sx(t)}
              y={pad.top + plotH + 18}
              textAnchor="middle"
              className="bench-chart-tick"
            >
              {t.toLocaleString()}
            </text>
          </g>
        ))}

        <line
          x1={pad.left}
          x2={pad.left + plotW}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          className="bench-chart-axis"
        />
        <line
          x1={pad.left}
          x2={pad.left}
          y1={pad.top}
          y2={pad.top + plotH}
          className="bench-chart-axis"
        />
        <text
          x={pad.left + plotW / 2}
          y={height - 4}
          textAnchor="middle"
          className="bench-chart-label"
        >
          N (calls per run)
        </text>
        <text
          x={-(pad.top + plotH / 2)}
          y={14}
          textAnchor="middle"
          transform="rotate(-90)"
          className="bench-chart-label"
        >
          Throughput (ops/s)
        </text>

        {samples.map((s, i) => (
          <circle
            key={i}
            cx={sx(s.n)}
            cy={sy(s.opsPerSec)}
            r={4}
            fill={COLORS[s.mode]}
            stroke="canvas"
            strokeWidth={1.5}
          >
            <title>
              {s.mode} × {s.n.toLocaleString()} — {Math.round(s.opsPerSec).toLocaleString()} ops/s ·{' '}
              {s.elapsedMs.toFixed(1)} ms
            </title>
          </circle>
        ))}
      </svg>
      <div className="bench-legend">
        {(['parallel', 'sequential'] as const).map((mode) => (
          <span key={mode}>
            <span className="bench-swatch" style={{ background: COLORS[mode] }} />
            {mode}
          </span>
        ))}
      </div>
    </div>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const rough = range / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const step = (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10) * pow;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 2; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

function formatOps(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
