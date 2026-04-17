import type { Hub, SharedTabService } from '@hurling/shared-tab-service';

export interface CounterEvents extends Record<string, unknown> {
  changed: { value: number; byTab: string };
}

export class CounterService implements SharedTabService<CounterEvents, 'counter'> {
  readonly namespace = 'counter' as const;
  readonly __events?: CounterEvents;
  private hub?: Hub;
  private count = 0;

  init(hub: Hub): void {
    this.hub = hub;
  }

  async increment(byTab: string): Promise<number> {
    this.count += 1;
    this.hub?.emit(this.namespace, 'changed', { value: this.count, byTab });
    return this.count;
  }

  async get(): Promise<number> {
    return this.count;
  }
}

export function createServices() {
  return {
    counter: new CounterService(),
  };
}
