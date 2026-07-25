import { describe, expect, it } from 'vitest';
import { bodyHash } from '../src/services/idempotency';

describe('idempotency body hashing', () => {
  it('does not depend on object key order', () => {
    expect(bodyHash({ b: 2, a: { y: 2, x: 1 } })).toBe(bodyHash({ a: { x: 1, y: 2 }, b: 2 }));
  });

  it('changes when request content changes', () => {
    expect(bodyHash({ enabled: true })).not.toBe(bodyHash({ enabled: false }));
  });
});
