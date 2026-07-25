import { describe, expect, it } from 'vitest';
import { hasOpenBottomSheet } from '../src/utils/tab-bar-visibility';

describe('tab bar visibility', () => {
  it('stays hidden while any bottom sheet is open', () => {
    expect(hasOpenBottomSheet(false, false, true)).toBe(true);
    expect(hasOpenBottomSheet(true, false, false)).toBe(true);
  });

  it('can be shown after all bottom sheets close', () => {
    expect(hasOpenBottomSheet(false, false, false)).toBe(false);
  });
});
