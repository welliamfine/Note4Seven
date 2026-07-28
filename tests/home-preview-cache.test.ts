import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyHomePreviewUpdates,
  consumeHomePreviewUpdates,
  homePreviewsFromRecords,
  mergeHomePreviewSnapshot,
  needsHomePreviewVerification,
  queueHomePreviewUpdate,
} from '../src/services/home-preview-cache';

describe('home preview cache', () => {
  afterEach(async () => {
    await consumeHomePreviewUpdates();
    vi.unstubAllGlobals();
  });

  it('starts preloading immediately and waits before exposing the update', async () => {
    let finishPreload: (() => void) | undefined;
    vi.stubGlobal('wx', {
      getImageInfo: vi.fn(({ success }: { success: () => void }) => {
        finishPreload = success;
      }),
    });

    void queueHomePreviewUpdate({
      type: 'upsert',
      moduleId: 'module_1',
      recordId: 'record_2',
      stickerPath: 'https://media.test/new-sticker.png',
    });
    let consumed = false;
    const updatesPromise = consumeHomePreviewUpdates().then((updates) => {
      consumed = true;
      return updates;
    });

    await Promise.resolve();
    expect(wx.getImageInfo).toHaveBeenCalledWith(expect.objectContaining({
      src: 'https://media.test/new-sticker.png',
    }));
    expect(consumed).toBe(false);
    finishPreload?.();
    await expect(updatesPromise).resolves.toEqual([expect.objectContaining({ recordId: 'record_2' })]);
  });

  it('replaces and removes only the changed record while keeping display order compact', () => {
    const previews = [
      { recordId: 'record_1', stickerPath: '/one.png', displayOrder: 0 },
      { recordId: 'record_2', stickerPath: '/two.png', displayOrder: 1 },
    ];
    const replaced = applyHomePreviewUpdates(previews, [{
      type: 'upsert',
      moduleId: 'module_1',
      recordId: 'record_3',
      previousRecordId: 'record_1',
      stickerPath: '/three.png',
    }]);

    expect(replaced).toEqual([
      { recordId: 'record_3', stickerPath: '/three.png', displayOrder: 0 },
      { recordId: 'record_2', stickerPath: '/two.png', displayOrder: 1 },
    ]);
    expect(applyHomePreviewUpdates(replaced, [{
      type: 'remove',
      moduleId: 'module_1',
      recordId: 'record_3',
    }])).toEqual([
      { recordId: 'record_2', stickerPath: '/two.png', displayOrder: 0 },
    ]);
  });

  it('ignores renewed URL signatures and animates only a genuinely new remote sticker', () => {
    const current = [{
      recordId: 'record_1',
      stickerPath: 'https://media.test/one.png?signature=old',
      displayOrder: 0,
    }];
    const plan = mergeHomePreviewSnapshot(current, [
      { recordId: 'record_1', stickerPath: 'https://media.test/one.png?signature=new', displayOrder: 0 },
      { recordId: 'record_2', stickerPath: 'https://media.test/two.png?signature=new', displayOrder: 1 },
    ]);

    expect(plan.previews[0]).toBe(current[0]);
    expect(plan.previews[1]).toMatchObject({ recordId: 'record_2', motionPhase: 'sticker-hidden' });
    expect(plan.animatedIndexes).toEqual([1]);
    expect(plan.animatedSources).toEqual(['https://media.test/two.png?signature=new']);
  });

  it('verifies a snapshot that replaces an active member sticker with a new member sticker', () => {
    const current = [
      { recordId: 'record_1', memberInstanceId: 'member_1', stickerPath: '/one.png', displayOrder: 0 },
      { recordId: 'record_2', memberInstanceId: 'member_2', stickerPath: '/two.png', displayOrder: 1 },
      { recordId: 'record_3', memberInstanceId: 'member_3', stickerPath: '/three.png', displayOrder: 2 },
    ];
    const incomplete = [
      current[1],
      current[2],
      { recordId: 'record_4', memberInstanceId: 'member_4', stickerPath: '/four.png', displayOrder: 2 },
    ];
    const members = ['member_1', 'member_2', 'member_3', 'member_4'].map((memberInstanceId, index) => ({
      memberInstanceId,
      userId: `user_${index + 1}`,
      nickname: `Member ${index + 1}`,
      avatarText: String(index + 1),
      avatarColor: '#eee',
      role: index === 0 ? 'creator' as const : 'member' as const,
      joinSequence: index + 1,
      joinedAt: `2026-07-0${index + 1}T00:00:00+08:00`,
      active: true,
    }));

    expect(needsHomePreviewVerification(current, incomplete, members)).toBe(true);
    expect(needsHomePreviewVerification(current, incomplete, members.slice(1))).toBe(false);
    expect(needsHomePreviewVerification(incomplete, incomplete, members, true)).toBe(true);
  });

  it('rebuilds the authoritative four-item preview in effective-time order', () => {
    const records = [1, 2, 3, 4].map((index) => ({
      recordId: `record_${index}`,
      moduleId: 'module_1',
      memberInstanceId: `member_${index}`,
      userId: `user_${index}`,
      recordDate: '2026-07-28',
      originalPath: `/${index}.png`,
      stickerPath: `/${index}.png`,
      remark: '',
      source: 'normal' as const,
      status: 'active' as const,
      firstEffectiveAt: `2026-07-28T00:00:0${index}+08:00`,
      updatedAt: `2026-07-28T00:00:0${index}+08:00`,
    }));

    expect(homePreviewsFromRecords(records)).toEqual(records.map((record, displayOrder) => ({
      recordId: record.recordId,
      memberInstanceId: record.memberInstanceId,
      stickerPath: record.stickerPath,
      displayOrder,
    })));
  });
});
