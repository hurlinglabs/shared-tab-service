/**
 * Thrown for in-flight RPC calls that were waiting on a leader which has gone
 * away. The call may or may not have executed on the old leader before it
 * died — callers that mark a method idempotent get transparent retry; everyone
 * else sees this error and decides themselves.
 *
 * Catchable via `instanceof LeaderChangedError` or by checking `.code`.
 */
export class LeaderChangedError extends Error {
  readonly name = 'LeaderChangedError';
  readonly code = 'LEADER_CHANGED' as const;
  constructor(message = 'Leader changed before reply was received') {
    super(message);
  }
}

interface TabInternals {
  _callDeferreds: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  _sentCalls: Map<number, ReturnType<typeof setTimeout>>;
}

interface SpokeInternals {
  tab: TabInternals;
}

/**
 * Reject every deferred currently waiting on a reply from the (now-gone)
 * leader. Reaches into `tab-election`'s private `_callDeferreds` map — see
 * docs/spec/20260430-leader-change-fast-fail.md §2 for the reasoning. Once
 * `tab.failPending(err)` lands upstream we'll swap to that.
 */
export function failPendingCalls(spoke: object, err: Error): void {
  const tab = (spoke as unknown as SpokeInternals).tab;
  if (!tab) return;
  const deferreds = tab._callDeferreds;
  if (deferreds && typeof deferreds.forEach === 'function') {
    for (const [, d] of deferreds) {
      clearTimeout(d.timeout);
      d.reject(err);
    }
    deferreds.clear();
  }
  const sent = tab._sentCalls;
  if (sent && typeof sent.forEach === 'function') {
    for (const [, t] of sent) clearTimeout(t);
    sent.clear();
  }
}
