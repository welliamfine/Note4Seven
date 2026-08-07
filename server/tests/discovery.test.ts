import { describe, expect, it } from 'vitest';
import {
  discoveryCursor,
  copyDiscoverySnapshot,
  effectiveRecruitmentStatus,
  monthRange,
  normalizePublicText,
  parseDiscoveryCursor,
  publicSnapshot,
} from '../src/services/discovery';
import type { StorageService } from '../src/services/storage';

describe('discovery public snapshots', () => {
  it('uses opaque descending cursors', () => {
    expect(discoveryCursor('42')).toBe('dp_42');
    expect(parseDiscoveryCursor('dp_42')).toBe('42');
    expect(() => parseDiscoveryCursor('post_42')).toThrow('分页游标格式不正确');
  });

  it('resolves nested file keys without exposing private storage keys', async () => {
    const storage = {
      signedUrl: async (key: string) => `https://assets.example/${key}`,
    } as StorageService;
    const result = await publicSnapshot(storage, {
      stickerFileKey: 'private/sticker.webp',
      members: [{ avatarFileKey: 'private/avatar.webp' }],
      publicText: 'safe',
    });
    expect(result).toEqual({
      stickerUrl: 'https://assets.example/private/sticker.webp',
      members: [{ avatarUrl: 'https://assets.example/private/avatar.webp' }],
      publicText: 'safe',
    });
    expect(JSON.stringify(result)).not.toContain('FileKey');
  });

  it('copies every distinct asset into an immutable discovery prefix', async () => {
    const copies: Array<[string, string]> = [];
    const storage = {
      copyObject: async (source: string, destination: string) => { copies.push([source, destination]); },
    } as StorageService;
    const result = await copyDiscoverySnapshot(storage, {
      boardFileKey: 'private/board.webp',
      items: [
        { imageFileKey: 'private/sticker.png' },
        { imageFileKey: 'private/sticker.png' },
      ],
    }, 'discover/snapshots/7/request_123');
    expect(copies).toEqual([
      ['private/board.webp', 'discover/snapshots/7/request_123/asset-001.webp'],
      ['private/sticker.png', 'discover/snapshots/7/request_123/asset-002.png'],
    ]);
    expect(result).toEqual({
      boardFileKey: 'discover/snapshots/7/request_123/asset-001.webp',
      items: [
        { imageFileKey: 'discover/snapshots/7/request_123/asset-002.png' },
        { imageFileKey: 'discover/snapshots/7/request_123/asset-002.png' },
      ],
    });
  });

  it('builds exact calendar month boundaries', () => {
    expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', endExclusive: '2024-03-01' });
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01' });
  });

  it('derives recruitment status from live capacity and expiry', () => {
    const future = new Date(Date.now() + 60_000);
    expect(effectiveRecruitmentStatus({ status: 'recruiting', expire_at: future, module_status: 'active', active_member_count: 2, member_limit: 4 })).toBe('recruiting');
    expect(effectiveRecruitmentStatus({ status: 'recruiting', expire_at: future, module_status: 'active', active_member_count: 4, member_limit: 4 })).toBe('full');
    expect(effectiveRecruitmentStatus({ status: 'recruiting', expire_at: new Date(0), module_status: 'active', active_member_count: 1, member_limit: 4 })).toBe('expired');
    expect(effectiveRecruitmentStatus({ status: 'recruiting', expire_at: future, module_status: 'deleted', active_member_count: 1, member_limit: 4 })).toBe('closed');
  });

  it('normalizes optional public copy', () => {
    expect(normalizePublicText('  hello\r\nworld  ')).toBe('hello\nworld');
    expect(normalizePublicText('   ')).toBeNull();
  });
});
