import type { Hub, SharedTabService } from '@hurling/shared-tab-service';

export interface CounterEvents extends Record<string, unknown> {
  changed: { value: number; byTab: string };
}

export class CounterService implements SharedTabService<'counter', CounterEvents> {
  readonly namespace = 'counter' as const;
  readonly __events?: CounterEvents;
  private hub?: Hub;
  private count = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastByTab = '';

  init(hub: Hub): void {
    this.hub = hub;
  }

  async increment(byTab: string): Promise<number> {
    this.count += 1;
    this.lastByTab = byTab;
    this.scheduleEmit();
    return this.count;
  }

  async get(): Promise<number> {
    return this.count;
  }

  private scheduleEmit(): void {
    if (this.emitTimer !== null) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.hub?.emit(this.namespace, 'changed', {
        value: this.count,
        byTab: this.lastByTab,
      });
    }, 0);
  }
}

export function createServices() {
  return {
    counter: new CounterService(),
  };
}
