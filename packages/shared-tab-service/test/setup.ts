/**
 * Polyfills the browser-only globals shared-tab-service depends on so that the
 * real Hub/Spoke/BroadcastChannel code paths can run under Node + Vitest.
 *
 * - `self` is aliased to `globalThis` so `isBrowserLike()` passes.
 * - `navigator.locks` is implemented in-process. The polyfill is intentionally
 *   minimal: it supports the request/release queue, `ifAvailable`, `steal`, and
 *   `signal` — enough for `tab-election` to do leader election and recovery.
 * - `BroadcastChannel` is provided natively by Node (>= 15.4), so we leave it
 *   alone.
 */

if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  (globalThis as { self: typeof globalThis }).self = globalThis;
}

// `tab-election` does `instanceof SharedWorker` / `instanceof Worker` in its
// hot paths — both must exist as constructors for the in-tab path to work.
const g = globalThis as Record<string, unknown>;
if (typeof g.SharedWorker === 'undefined') {
  // oxlint-disable-next-line typescript/no-extraneous-class
  g.SharedWorker = class {} as unknown as typeof SharedWorker;
}
if (typeof g.Worker === 'undefined') {
  // oxlint-disable-next-line typescript/no-extraneous-class
  g.Worker = class {} as unknown as typeof Worker;
}

interface LockHolder {
  release: () => void;
}

type LockCallback = (lock: { name: string } | null) => unknown;

interface LockOptions {
  mode?: 'exclusive' | 'shared';
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

const heldLocks = new Map<string, LockHolder | null>();
const waitQueues = new Map<string, Array<() => void>>();

const queueFor = (name: string): Array<() => void> => {
  let q = waitQueues.get(name);
  if (!q) {
    q = [];
    waitQueues.set(name, q);
  }
  return q;
};

const acquireNow = (name: string): (() => void) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldLocks.set(name, { release });
  void released.then(() => {
    heldLocks.set(name, null);
    const next = queueFor(name).shift();
    if (next) next();
  });
  return release;
};

async function request(
  name: string,
  optionsOrCallback: LockOptions | LockCallback,
  maybeCallback?: LockCallback,
): Promise<unknown> {
  let options: LockOptions = {};
  let callback: LockCallback;
  if (typeof optionsOrCallback === 'function') {
    callback = optionsOrCallback;
  } else {
    options = optionsOrCallback;
    callback = maybeCallback as LockCallback;
  }

  const currentlyHeld = heldLocks.get(name);

  if (options.ifAvailable && currentlyHeld) {
    return await callback(null);
  }

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  if (options.steal && currentlyHeld) {
    currentlyHeld.release();
    heldLocks.set(name, null);
  }

  await new Promise<void>((resolve, reject) => {
    const tryAcquire = (): void => {
      if (!heldLocks.get(name)) {
        resolve();
      } else {
        queueFor(name).push(tryAcquire);
      }
    };
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        const q = queueFor(name);
        const idx = q.indexOf(tryAcquire);
        if (idx >= 0) q.splice(idx, 1);
        reject(options.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
      });
    }
    tryAcquire();
  });

  // Abort may have fired during the microtask boundary between resolving the
  // wait promise and reaching this point. Real navigator.locks rejects in that
  // case rather than running the callback.
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  const release = acquireNow(name);
  try {
    return await callback({ name });
  } finally {
    release();
  }
}

if (
  typeof navigator === 'undefined' ||
  typeof (navigator as Navigator & { locks?: unknown }).locks === 'undefined'
) {
  const nav: Navigator =
    typeof navigator === 'undefined' ? ({} as Navigator) : (navigator as Navigator);
  Object.defineProperty(nav, 'locks', {
    value: { request },
    configurable: true,
    writable: true,
  });
  if (typeof navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      configurable: true,
      writable: true,
    });
  }
}
