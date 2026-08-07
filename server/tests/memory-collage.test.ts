import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import {
  memoryCollageScopeKey,
  validateMemoryCollageItems,
  type MemoryCollageTransform,
} from '../src/services/memory-collage';

const recordItem = (zIndex = 0): MemoryCollageTransform => ({
  assetType: 'record_sticker',
  recordId: '1',
  x: 0.5,
  y: 0.5,
  width: 0.2,
  height: 0.3,
  rotation: 0,
  zIndex,
});

describe('memory collage service contract', () => {
  it('keeps all-module and module compositions isolated', () => {
    expect(memoryCollageScopeKey()).toBe('all');
    expect(memoryCollageScopeKey('42')).toBe('module:42');
  });

  it('accepts a valid complete snapshot', () => {
    expect(() => validateMemoryCollageItems([recordItem()])).not.toThrow();
  });

  it('rejects duplicate layers and mismatched asset references', () => {
    expect(() => validateMemoryCollageItems([recordItem(0), recordItem(0)]))
      .toThrowError(expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }));
    expect(() => validateMemoryCollageItems([{ ...recordItem(), stickerAssetId: '2' }]))
      .toThrowError(expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }));
  });

  it('enforces the twenty-sticker total limit', () => {
    expect(() => validateMemoryCollageItems(Array.from({ length: 21 }, (_, index) => recordItem(index))))
      .toThrowError(expect.objectContaining<AppError>({ code: 'COLLAGE_ITEM_LIMIT' }));
  });
});
