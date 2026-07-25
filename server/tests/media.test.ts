import { describe, expect, it } from 'vitest';
import { normalizeMediaSourceType } from '../src/routes/media';

describe('media upload source normalization', () => {
  it('maps the WeChat album picker value to the backend gallery value', () => {
    expect(normalizeMediaSourceType('album')).toBe('gallery');
    expect(normalizeMediaSourceType('gallery')).toBe('gallery');
    expect(normalizeMediaSourceType('camera')).toBe('camera');
  });
});
