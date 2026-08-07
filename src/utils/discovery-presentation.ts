import type { DiscoveryBoardItem, DiscoveryPost } from '../services/discovery-api';

export interface DiscoveryCalendarCell {
  key: string;
  day: string;
  inMonth: boolean;
  records: Array<{ stickerUrl: string; memberName: string }>;
}

export interface DiscoveryPostPresentation extends DiscoveryPost {
  author: DiscoveryPost['author'] & { avatarText: string };
  typeLabel: string;
  timeLabel: string;
  calendarCells: DiscoveryCalendarCell[];
  boardItems: Array<DiscoveryBoardItem & { style: string }>;
  recruitmentStatusLabel: string;
  actionLabel: string;
}

const TYPE_LABELS: Record<DiscoveryPost['postType'], string> = {
  record: '今日记录',
  calendar: '多人日历',
  board: '回忆拼贴',
  easter_egg: '彩蛋时刻',
  module_recruitment: '邀请一起记录',
};

export function presentDiscoveryPost(post: DiscoveryPost, now = new Date()): DiscoveryPostPresentation {
  return {
    ...post,
    author: { ...post.author, avatarText: post.author.name.slice(0, 1) || '记' },
    typeLabel: TYPE_LABELS[post.postType],
    timeLabel: relativeTime(post.publishedAt, now),
    calendarCells: post.postType === 'calendar'
      ? buildCalendarCells(post.snapshot.month ?? '', post.snapshot.records ?? [])
      : [],
    boardItems: (post.snapshot.items ?? []).map((item) => ({
      ...item,
      style: boardItemStyle(item),
    })),
    recruitmentStatusLabel: recruitmentStatus(post),
    actionLabel: post.likedByViewer ? '已赞' : '赞',
  };
}

export function buildCalendarCells(
  month: string,
  records: Array<{ recordDate: string; stickerUrl: string; memberName: string }>,
): DiscoveryCalendarCell[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const recordsByDate = new Map<string, Array<{ stickerUrl: string; memberName: string }>>();
  records.forEach((record) => {
    const list = recordsByDate.get(record.recordDate) ?? [];
    list.push({ stickerUrl: record.stickerUrl, memberName: record.memberName });
    recordsByDate.set(record.recordDate, list);
  });
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    const inMonth = day >= 1 && day <= days;
    const date = inMonth ? `${month}-${String(day).padStart(2, '0')}` : '';
    return {
      key: `${month}-${index}`,
      day: inMonth ? String(day) : '',
      inMonth,
      records: date ? (recordsByDate.get(date) ?? []).slice(0, 4) : [],
    };
  });
}

export function boardItemStyle(item: DiscoveryBoardItem): string {
  return [
    `left:${item.x * 100}%`,
    `top:${item.y * 100}%`,
    `width:${item.width * 100}%`,
    `height:${item.height * 100}%`,
    `z-index:${item.zIndex}`,
    `transform:translate(-50%,-50%) rotate(${item.rotation}deg)`,
  ].join(';');
}

function recruitmentStatus(post: DiscoveryPost): string {
  if (post.postType !== 'module_recruitment') return '';
  if (post.snapshot.recruitmentStatus === 'full') return '成员已满';
  if (post.snapshot.recruitmentStatus === 'expired') return '招募已到期';
  if (post.snapshot.recruitmentStatus === 'closed') return '招募已结束';
  const openSlots = Number(post.snapshot.openSlots ?? 0);
  return openSlots > 0 ? `还可以加入 ${openSlots} 人` : '成员已满';
}

function relativeTime(value: string, now: Date): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
