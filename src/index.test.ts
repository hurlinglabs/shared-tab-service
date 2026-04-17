import { describe, expect, it } from 'vitest';
import { SharedTabService } from './index.js';

describe('SharedTabService', () => {
  it('wraps the message with a from id', () => {
    const service = new SharedTabService();
    const result = service.send({ type: 'ping' });
    expect(result.type).toBe('ping');
    expect(typeof result.from).toBe('string');
  });
});
