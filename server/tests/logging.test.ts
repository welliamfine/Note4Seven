import { describe, expect, it } from 'vitest';
import { sanitizeRequestUrl } from '../src/app';

describe('request log redaction', () => {
  it('redacts invite credentials while preserving the route shape', () => {
    expect(sanitizeRequestUrl('/api/v1/invites/inv_12_secret-value/applications?from=share'))
      .toBe('/api/v1/invites/[REDACTED]/applications?from=share');
    expect(sanitizeRequestUrl('/api/v1/public/invite-scenes/secret-value'))
      .toBe('/api/v1/public/invite-scenes/[REDACTED]');
  });

  it('leaves ordinary API paths unchanged', () => {
    expect(sanitizeRequestUrl('/api/v1/modules/m_2?month=2026-07')).toBe('/api/v1/modules/m_2?month=2026-07');
  });
});
