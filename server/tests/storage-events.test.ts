import { describe, expect, it } from 'vitest';
import { verifyEventToken } from '../src/routes/storage-events';

describe('storage event token rotation', () => {
  it('accepts current and previous values but rejects other values', () => {
    expect(() => verifyEventToken('current-token-value-at-least-24', ['current-token-value-at-least-24', 'previous-token-value-at-least-24']))
      .not.toThrow();
    expect(() => verifyEventToken('previous-token-value-at-least-24', ['current-token-value-at-least-24', 'previous-token-value-at-least-24']))
      .not.toThrow();
    expect(() => verifyEventToken('untrusted-token-value-at-least-24', ['current-token-value-at-least-24', null]))
      .toThrow('存储事件来源不正确');
  });
});
