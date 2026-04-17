export const BATCH_NAMESPACE = '__sts_batch' as const;
export const BATCH_METHOD = 'dispatch' as const;
export const BATCH_EVENT = 'events' as const;

export interface BatchCall {
  ns: string;
  method: string;
  args: unknown[];
}

export type BatchResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface BatchedEvent {
  ns: string;
  event: string;
  payload: unknown;
}

export interface BatchSettings {
  enabled: boolean;
  flushMs: number;
}

export type BatchOption = boolean | { flushMs?: number };

export function resolveBatchSettings(option: BatchOption | undefined): BatchSettings {
  if (option === false) return { enabled: false, flushMs: 0 };
  if (option === true || option === undefined) return { enabled: true, flushMs: 0 };
  return { enabled: true, flushMs: option.flushMs ?? 0 };
}
