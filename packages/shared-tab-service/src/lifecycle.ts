import type { Hub, Service as TabElectionService } from 'tab-election/hub';
import type { SharedTabService } from './service.js';

export const LIFECYCLE_NAMESPACE = '__sts_lifecycle' as const;

export interface HeartbeatSettings {
  intervalMs: number;
  ttlMs: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatSettings = {
  intervalMs: 5000,
  ttlMs: 15000,
};

export type HeartbeatOption = boolean | { intervalMs?: number; ttlMs?: number };

export function resolveHeartbeatSettings(
  option: HeartbeatOption | undefined,
): HeartbeatSettings | null {
  if (option === false) return null;
  if (option === true || option === undefined) return { ...DEFAULT_HEARTBEAT };
  return {
    intervalMs: option.intervalMs ?? DEFAULT_HEARTBEAT.intervalMs,
    ttlMs: option.ttlMs ?? DEFAULT_HEARTBEAT.ttlMs,
  };
}

export interface SubscriberCounts {
  /**
   * Number of distinct spokes (client instances) currently subscribed.
   * A spoke is one `createSharedTabService(...)` instance — depending on the
   * app this typically corresponds to one tab/window, but a single tab can
   * host multiple spokes if it constructs the client more than once. Count
   * spokes, not windows.
   */
  spokes: number;
  /** Total number of `.on(event, …)` callbacks summed across all spokes. */
  listeners: number;
}

export interface ConnectedSpoke {
  id: string;
  version?: string;
  connectedAt: number;
  lastSeen: number;
}

interface SpokeState extends ConnectedSpoke {
  /** Per-namespace per-event listener count from this spoke. */
  subs: Map<string, Map<string, number>>;
}

/**
 * Per-(namespace, event) aggregate counts plus a service-side hook
 * that fires whenever the aggregate changes. Lives on the hub.
 */
export class LifecycleManager {
  private spokes = new Map<string, SpokeState>();
  /** namespace -> event -> aggregate */
  private aggregate = new Map<string, Map<string, SubscriberCounts>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly settings: HeartbeatSettings,
    private services: Map<string, SharedTabService>,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    const sweepEvery = Math.max(50, Math.floor(this.settings.intervalMs / 2));
    this.timer = setInterval(() => this.sweep(), sweepEvery);
    const t = this.timer as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    delete this.timer;
  }

  hello(spokeId: string, version?: string): void {
    const existing = this.spokes.get(spokeId);
    if (existing) {
      existing.lastSeen = this.now();
      return;
    }
    this.spokes.set(spokeId, {
      id: spokeId,
      ...(version !== undefined ? { version } : {}),
      connectedAt: this.now(),
      lastSeen: this.now(),
      subs: new Map(),
    });
  }

  hb(spokeId: string): void {
    const s = this.spokes.get(spokeId);
    if (s) s.lastSeen = this.now();
    else this.hello(spokeId);
  }

  sub(spokeId: string, ns: string, event: string, count: number): void {
    let s = this.spokes.get(spokeId);
    if (!s) {
      this.hello(spokeId);
      s = this.spokes.get(spokeId)!;
    }
    s.lastSeen = this.now();
    let nsMap = s.subs.get(ns);
    if (!nsMap) {
      if (count <= 0) {
        this.recompute(ns, event);
        return;
      }
      nsMap = new Map();
      s.subs.set(ns, nsMap);
    }
    if (count <= 0) {
      nsMap.delete(event);
      if (nsMap.size === 0) s.subs.delete(ns);
    } else {
      nsMap.set(event, count);
    }
    this.recompute(ns, event);
  }

  bye(spokeId: string): void {
    const s = this.spokes.get(spokeId);
    if (!s) return;
    this.spokes.delete(spokeId);
    const touched: Array<[string, string]> = [];
    for (const [ns, nsMap] of s.subs) {
      for (const event of nsMap.keys()) touched.push([ns, event]);
    }
    for (const [ns, event] of touched) this.recompute(ns, event);
  }

  /** Drop spokes that have not heartbeat within the TTL window. */
  sweep(): void {
    const cutoff = this.now() - this.settings.ttlMs;
    const expired: string[] = [];
    for (const [id, s] of this.spokes) if (s.lastSeen < cutoff) expired.push(id);
    for (const id of expired) this.bye(id);
  }

  private recompute(ns: string, event: string): void {
    let spokes = 0;
    let listeners = 0;
    for (const s of this.spokes.values()) {
      const c = s.subs.get(ns)?.get(event);
      if (c && c > 0) {
        spokes += 1;
        listeners += c;
      }
    }
    let nsAgg = this.aggregate.get(ns);
    const prev = nsAgg?.get(event);
    if (prev && prev.spokes === spokes && prev.listeners === listeners) return;
    if (spokes === 0 && listeners === 0) {
      nsAgg?.delete(event);
      if (nsAgg && nsAgg.size === 0) this.aggregate.delete(ns);
    } else {
      if (!nsAgg) {
        nsAgg = new Map();
        this.aggregate.set(ns, nsAgg);
      }
      nsAgg.set(event, { spokes, listeners });
    }
    this.fireHook(ns, event, { spokes, listeners });
  }

  private fireHook(ns: string, event: string, counts: SubscriberCounts): void {
    const svc = this.services.get(ns) as
      | (SharedTabService & {
          onSubscribersChanged?(counts: SubscriberCounts, eventName: string): void;
        })
      | undefined;
    if (!svc?.onSubscribersChanged) return;
    try {
      svc.onSubscribersChanged(counts, event);
    } catch {
      /* hook is informational; never let a service throw take down the manager */
    }
  }

  getConnectedSpokes(): ConnectedSpoke[] {
    return Array.from(this.spokes.values()).map(({ id, version, connectedAt, lastSeen }) => ({
      id,
      ...(version !== undefined ? { version } : {}),
      connectedAt,
      lastSeen,
    }));
  }

  getConnectedSpokeCount(): number {
    return this.spokes.size;
  }

  getSubscriberSpokeCount(ns: string, event?: string): number {
    const nsAgg = this.aggregate.get(ns);
    if (!nsAgg) return 0;
    if (event !== undefined) return nsAgg.get(event)?.spokes ?? 0;
    let total = 0;
    for (const v of nsAgg.values()) total += v.spokes;
    return total;
  }

  getListenerCount(ns: string, event?: string): number {
    const nsAgg = this.aggregate.get(ns);
    if (!nsAgg) return 0;
    if (event !== undefined) return nsAgg.get(event)?.listeners ?? 0;
    let total = 0;
    for (const v of nsAgg.values()) total += v.listeners;
    return total;
  }
}

interface LifecycleService extends TabElectionService {
  hello(args: { spokeId: string; version?: string }): void;
  hb(args: { spokeId: string }): void;
  sub(args: { spokeId: string; ns: string; event: string; count: number }): void;
  bye(args: { spokeId: string }): void;
}

export function createLifecycleService(manager: LifecycleManager): LifecycleService {
  return {
    namespace: LIFECYCLE_NAMESPACE,
    hello({ spokeId, version }) {
      manager.hello(spokeId, version);
    },
    hb({ spokeId }) {
      manager.hb(spokeId);
    },
    sub({ spokeId, ns, event, count }) {
      manager.sub(spokeId, ns, event, count);
    },
    bye({ spokeId }) {
      manager.bye(spokeId);
    },
  };
}

/**
 * Attach the lifecycle manager to the hub instance under a non-enumerable
 * `__lifecycle` property so app code with in-tab access to the Hub can read
 * telemetry (`(hub as any).__lifecycle.getConnectedSpokes()`). The manager
 * owns the sweep timer; it is stopped explicitly when the hub teardown runs.
 */
export function attachManagerToHub(hub: Hub, manager: LifecycleManager): void {
  Object.defineProperty(hub, '__lifecycle', {
    value: manager,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/** Spoke-side controller. Owns the spokeId, heartbeat timer and listener counts. */
export class SpokeLifecycle {
  readonly spokeId: string;
  private hbTimer?: ReturnType<typeof setInterval>;
  /** ns -> event -> count */
  private localCounts = new Map<string, Map<string, number>>();
  private silentClose = false;

  constructor(
    private dispatch: (method: string, args: unknown) => void,
    private settings: HeartbeatSettings,
    private version?: string,
  ) {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    this.spokeId =
      typeof c?.randomUUID === 'function'
        ? c.randomUUID()
        : `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }

  start(): void {
    this.dispatch('hello', { spokeId: this.spokeId, version: this.version });
    this.hbTimer = setInterval(() => {
      this.dispatch('hb', { spokeId: this.spokeId });
    }, this.settings.intervalMs);
    const t = this.hbTimer as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /**
   * Increment local listener count for (ns, event) and notify hub.
   * Returns a function that decrements and notifies.
   */
  trackSubscribe(ns: string, event: string): () => void {
    let nsMap = this.localCounts.get(ns);
    if (!nsMap) {
      nsMap = new Map();
      this.localCounts.set(ns, nsMap);
    }
    const next = (nsMap.get(event) ?? 0) + 1;
    nsMap.set(event, next);
    this.dispatch('sub', { spokeId: this.spokeId, ns, event, count: next });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = this.localCounts.get(ns);
      const cur = m?.get(event) ?? 0;
      const after = Math.max(0, cur - 1);
      if (m) {
        if (after === 0) m.delete(event);
        else m.set(event, after);
        if (m.size === 0) this.localCounts.delete(ns);
      }
      this.dispatch('sub', { spokeId: this.spokeId, ns, event, count: after });
    };
  }

  /** Test-only: simulate a tab crash — stop heartbeats but skip the goodbye. */
  simulateCrash(): void {
    this.silentClose = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    delete this.hbTimer;
  }

  stop(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    delete this.hbTimer;
    if (!this.silentClose) {
      this.dispatch('bye', { spokeId: this.spokeId });
    }
  }
}
