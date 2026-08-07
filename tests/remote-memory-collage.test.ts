import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ remoteRequest: vi.fn() }));

vi.mock('../src/services/transport-client', () => ({
  remoteRequest: transport.remoteRequest,
  uploadBackendFile: vi.fn(),
}));

import { getMemoryCollage, saveMemoryCollage } from '../src/services/remote-api';

const response = {
  reportMode: 'month',
  periodKey: '2026-08',
  scopeKey: 'all',
  moduleId: '',
  moduleName: '',
  collage: {
    collageId: 'collage_1',
    version: 2,
    savedAt: '2026-08-04T10:00:00+08:00',
    board: null,
    items: [{
      itemId: 'citem_1',
      assetType: 'record_sticker',
      recordId: 'r_1',
      moduleId: 'm_1',
      recordDate: '2026-08-01',
      imageUrl: 'https://signed.example/sticker.png',
      x: 0.5,
      y: 0.5,
      width: 0.2,
      height: 0.3,
      rotation: 5,
      zIndex: 0,
    }],
  },
  availableRecordStickers: [{
    recordId: 'r_1', moduleId: 'm_1', recordDate: '2026-08-01',
    stickerPath: 'https://signed.example/sticker.png', displayOrder: 0,
  }],
  boards: [],
  decorativeStickers: [],
  decorativeStickerCategories: [],
};

describe('remote memory collage', () => {
  beforeEach(() => {
    transport.remoteRequest.mockReset();
    transport.remoteRequest.mockResolvedValue(response);
  });

  it('loads signed production record sticker data without local asset substitution', async () => {
    const view = await getMemoryCollage(undefined, '2026-08', 'month');

    expect(transport.remoteRequest).toHaveBeenCalledWith('/memories/collage?mode=month&period=2026-08');
    expect(view.availableRecordStickers[0]?.stickerPath).toBe('https://signed.example/sticker.png');
    expect(view.collage?.items[0]?.imagePath).toBe('https://signed.example/sticker.png');
    expect(view.boards).toEqual([]);
    expect(view.decorativeStickers).toEqual([]);
  });

  it('saves a complete layout snapshot through the production endpoint', async () => {
    await saveMemoryCollage({
      reportMode: 'month',
      periodKey: '2026-08',
      baseVersion: 2,
      items: [{
        assetType: 'record_sticker', recordId: 'r_1', x: 0.5, y: 0.5,
        width: 0.2, height: 0.3, rotation: 5, zIndex: 0,
      }],
    });

    expect(transport.remoteRequest).toHaveBeenCalledWith('/memories/collage', expect.objectContaining({
      method: 'PUT',
      data: expect.objectContaining({
        moduleId: null,
        boardAssetId: null,
        baseVersion: 2,
        clientRequestId: expect.stringMatching(/^collage_save_/),
      }),
    }));
  });
});
