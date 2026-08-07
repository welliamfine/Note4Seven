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

const memoryOverview = (recordId: string) => ({
  reportMode: 'month',
  periodKey: '2026-07',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  isCurrentPeriod: true,
  moduleId: 'module_1',
  moduleName: 'Daily',
  modules: [{ moduleId: 'module_1', name: 'Daily' }],
  momentCount: 6,
  previousMomentCount: 4,
  recordedDays: 3,
  previousRecordedDays: 2,
  participatedModuleCount: 1,
  longestStreakDays: 4,
  previousLongestStreakDays: 2,
  currentStreakDays: 4,
  currentStreakOngoing: true,
  jointCompletedDays: 2,
  previousJointCompletedDays: 1,
  hasPartnerModules: true,
  earliestTime: '06:42',
  latestTime: '23:51',
  receivedReactionCount: 5,
  mostUsedEmojiCode: 'heart',
  latestStickerPath: '/latest.png',
  footprint: [{ date: '2026-07-01', recordCount: 1, level: 1 }],
  items: [{ recordId, moduleId: 'module_1', recordDate: '2026-07-01', stickerPath: `/${recordId}.png`, displayOrder: 0 }],
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
      if (path.startsWith('/memories/overview?')) return memoryOverview(path.includes('&group=') ? 'record_2' : 'record_1');
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('can refresh cached home cards without reloading notification details', async () => {
    const home = await getHomeModules({ reconcileNotifications: false });

    expect(home.pinned[0]?.moduleId).toBe('module_1');
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/home/modules')).toHaveLength(1);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/notifications')).toHaveLength(0);
  });

  it('uses the real overview endpoint and changes only the sticker group seed', async () => {
    await getMemoryView('module_1', '2026-07');
    const changed = await getMemoryView('module_1', '2026-07', true);

    expect(changed.items[0]?.recordId).toBe('record_2');
    expect(changed.latestStickerPath).toBe('/latest.png');
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/home/modules')).toHaveLength(0);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => path === '/notifications')).toHaveLength(0);
    expect(transport.remoteRequest.mock.calls.filter(([path]) => String(path).startsWith('/memories/overview?'))).toHaveLength(2);
    expect(String(transport.remoteRequest.mock.calls.at(-1)?.[0])).toContain('mode=month&period=2026-07&moduleId=module_1&group=');
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
