import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  remoteRequest: vi.fn(),
}));

vi.mock('../src/services/transport-client', () => ({
  remoteRequest: transport.remoteRequest,
  uploadBackendFile: vi.fn(),
}));

import {
  getCalendar,
  getCurrentUser,
  getHomeModules,
  getMemoryView,
  getModule,
} from '../src/services/remote-api';

const weeklyOverview = {
  recordedDays: 3,
  participatedModuleCount: 1,
  jointCompletedDays: 2,
  currentStreakDays: 4,
  receivedReactionCount: 5,
  weeklyRecordCount: 6,
};

const monthlyCard = (recordId: string) => ({
  currentUserRecordedDays: 3,
  jointCompletedDays: 2,
  receivedReactionCount: 5,
  mostUsedEmojiCode: 'heart',
  items: [{ recordId, stickerThumbnailUrl: `/${recordId}.png`, displayOrder: 0 }],
});

describe('remote memory view', () => {
  beforeEach(() => {
    transport.remoteRequest.mockReset();
    transport.remoteRequest.mockImplementation(async (path: string) => {
      if (path === '/home/modules') {
        return {
          groups: [
            {
              groupType: 'pinned',
              items: [{
                moduleId: 'module_1',
                moduleName: 'Daily',
                description: '',
                mode: 'solo',
                status: 'active',
                creatorUserId: 'user_1',
                createdAt: '2026-07-01T00:00:00+08:00',
                updatedAt: '2026-07-01T00:00:00+08:00',
                activeMembers: [],
                todayPreviewItems: [],
              }],
            },
            { groupType: 'normal', items: [] },
          ],
        };
      }
      if (path === '/notifications') return { items: [] };
      if (path === '/users/me') {
        return { userId: 'user_1', nickname: 'Seven', avatarUrl: '/avatar.png', unreadNotificationCount: 0 };
      }
      if (path === '/modules/module_1/calendar?month=2026-07') return { days: [] };
      if (path.startsWith('/memories/weekly-overview')) return weeklyOverview;
      if (path.startsWith('/memories/monthly-card?')) return monthlyCard('record_1');
      if (path === '/memories/monthly-card/change-group') return monthlyCard('record_2');
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('can refresh cached home cards without reloading notification details', async () => {
    const home = await getHomeModules({ reconcileNotifications: false });

    expect(home.pinned[0]?.moduleId).toBe('module_1');
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/home/modules')).toHaveLength(1);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/notifications')).toHaveLength(0);
  });

  it('reuses stable module and weekly context when only the sticker group changes', async () => {
    await getMemoryView('module_1', '2026-07');
    const changed = await getMemoryView('module_1', '2026-07', true);

    expect(changed.items[0]?.recordId).toBe('record_2');
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/home/modules')).toHaveLength(1);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/notifications')).toHaveLength(1);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => String(path).startsWith('/memories/weekly-overview'))).toHaveLength(1);
    expect(transport.remoteRequest).toHaveBeenLastCalledWith('/memories/monthly-card/change-group', expect.objectContaining({
      method: 'POST',
      data: expect.objectContaining({ moduleId: 'module_1', month: '2026-07' }),
    }));
  });

  it('reuses home module and user context on the detail critical path', async () => {
    await getHomeModules({ reconcileNotifications: false });
    await getCurrentUser();
    await getCurrentUser();
    await getModule('module_1');
    await getCalendar('module_1', '2026-07');

    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/users/me')).toHaveLength(1);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/modules/module_1')).toHaveLength(0);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/modules/module_1/calendar?month=2026-07')).toHaveLength(1);
  });
});
