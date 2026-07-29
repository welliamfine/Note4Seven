import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  resolveJoinApplication: vi.fn(),
  resolveMakeupApproval: vi.fn(),
}));

vi.mock('../src/services/api', () => api);
vi.mock('../src/services/tracker', () => ({ track: vi.fn() }));

interface PageDefinition {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

let pageDefinition: PageDefinition;

function createPage() {
  return {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(this: { data: Record<string, unknown> }, update: Record<string, unknown>) {
      Object.assign(this.data, update);
    },
  } as unknown as PageDefinition & {
    data: Record<string, any>;
    load: (background?: boolean) => Promise<void>;
    resolveMakeup: (event: WechatMiniprogram.TouchEvent) => Promise<void>;
  };
}

const base = {
  userId: 'user_1',
  moduleId: 'module_1',
  moduleName: '测试模块',
  targetId: 'target_1',
  recordDate: undefined,
  createdAt: '2026-07-28T08:00:00+08:00',
  updatedAt: '2026-07-28T08:00:00+08:00',
};

describe('notification center', () => {
  beforeEach(async () => {
    vi.resetModules();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.markNotificationRead.mockResolvedValue(undefined);
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      showToast: vi.fn(),
      navigateBack: vi.fn(),
      navigateTo: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/subpackages/notifications/index');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads text cards on entry but preserves pending action cards', async () => {
    api.getNotifications.mockResolvedValue([
      {
        ...base,
        notificationId: 'notification_text',
        type: 'member_change',
        title: '成员已退出',
        content: '成员已退出当前记录',
        targetType: 'member',
        actionType: 'none',
        actionStatus: 'none',
        isRead: false,
      },
      {
        ...base,
        notificationId: 'notification_join',
        type: 'join_application',
        title: '新的加入申请',
        content: '成员申请加入',
        targetType: 'join_application',
        actionType: 'approve_join',
        actionStatus: 'actionable',
        isRead: false,
        application: { applicationId: 'application_1', status: 'pending' },
      },
      {
        ...base,
        notificationId: 'notification_makeup',
        type: 'makeup_approval',
        title: '新的补卡申请',
        content: '成员申请补卡',
        targetType: 'makeup_approval',
        actionType: 'approve_makeup',
        actionStatus: 'actionable',
        isRead: false,
        approval: { approvalId: 'approval_1', status: 'pending' },
      },
    ]);

    const page = createPage();
    await page.load();

    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(api.markNotificationRead).toHaveBeenCalledWith('notification_text');
    expect(page.data.notifications.map((item: { notificationId: string; isRead: boolean }) => [item.notificationId, item.isRead])).toEqual([
      ['notification_text', true],
      ['notification_join', false],
      ['notification_makeup', false],
    ]);
  });

  it('shows the concurrent-resolution message and reloads makeup state', async () => {
    api.getNotifications.mockResolvedValue([]);
    api.resolveMakeupApproval.mockRejectedValue(Object.assign(new Error('APPROVAL_ALREADY_RESOLVED'), {
      code: 'APPROVAL_ALREADY_RESOLVED',
    }));

    const page = createPage();
    await page.resolveMakeup({
      currentTarget: { dataset: { approval: 'approval_1', action: 'approve' } },
    } as unknown as WechatMiniprogram.TouchEvent);

    expect(api.resolveMakeupApproval).toHaveBeenCalledWith('approval_1', 'approve');
    expect(wx.showToast).toHaveBeenCalledWith({ title: '已有人处理过', icon: 'none' });
    expect(api.getNotifications).toHaveBeenCalled();
    expect(page.data.processingIds).toEqual([]);
  });
});
