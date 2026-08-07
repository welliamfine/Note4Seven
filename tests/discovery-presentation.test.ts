import { describe, expect, it } from 'vitest';
import { boardItemStyle, buildCalendarCells, presentDiscoveryPost } from '../src/utils/discovery-presentation';
import type { DiscoveryPost } from '../src/services/discovery-api';

describe('discovery presentation', () => {
  it('places every public calendar sticker on its copied date', () => {
    const cells = buildCalendarCells('2024-02', [
      { recordDate: '2024-02-29', stickerUrl: 'leap.webp', memberName: '小七' },
      { recordDate: '2024-02-01', stickerUrl: 'first.webp', memberName: '小记' },
    ]);
    expect(cells).toHaveLength(42);
    expect(cells.find((cell) => cell.day === '29')?.records[0].stickerUrl).toBe('leap.webp');
    expect(cells.find((cell) => cell.day === '1')?.records[0].memberName).toBe('小记');
  });

  it('keeps board geometry stable with percentage positioning', () => {
    expect(boardItemStyle({
      assetType: 'record_sticker', name: '', imageUrl: 'a.webp',
      x: 0.25, y: 0.75, width: 0.2, height: 0.3, rotation: -12, zIndex: 3,
    })).toBe('left:25%;top:75%;width:20%;height:30%;z-index:3;transform:translate(-50%,-50%) rotate(-12deg)');
  });

  it('adds labels without mutating the server post contract', () => {
    const post: DiscoveryPost = {
      postId: 'post_1',
      postType: 'record',
      author: { userId: 'u_1', name: '小记', avatarUrl: null, isCurrentUser: true },
      publicText: '',
      snapshot: { recordDate: '2026-08-07', stickerUrl: 'record.webp' },
      likeCount: 0,
      commentCount: 0,
      likedByViewer: false,
      publishedAt: '2026-08-07T12:00:00+08:00',
    };
    const result = presentDiscoveryPost(post, new Date('2026-08-07T12:30:00+08:00'));
    expect(result.typeLabel).toBe('今日记录');
    expect(result.timeLabel).toBe('30 分钟前');
    expect(result.author.avatarText).toBe('小');
    expect(post.author).not.toHaveProperty('avatarText');
  });
});
