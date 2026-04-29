import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharedTabService, defineService } from './index.js';

describe('defineService', () => {
  it('attaches the namespace to the impl', () => {
    const db = defineService('db', {
      async getUser(id: string) {
        return { id };
      },
    });
    expect(db.namespace).toBe('db');
  });

  it('preserves impl methods', async () => {
    const auth = defineService('auth', {
      async whoami() {
        return 'alice';
      },
    });
    await expect(auth.whoami()).resolves.toBe('alice');
  });
});

describe('createSharedTabService (no browser runtime)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a stub client whose service calls reject', async () => {
    // Force the stub path even when the test polyfills are present.
    vi.stubGlobal('self', undefined);

    const db = defineService('db', {
      async ping() {
        return 'pong';
      },
    });
    const client = createSharedTabService({
      name: 'test-stub',
      services: { db },
    });
    expect(client.isLeader).toBe(false);
    await expect((client.db as unknown as { ping(): Promise<string> }).ping()).rejects.toThrow(
      /no browser runtime/,
    );
    client.close();
  });
});
