import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getModuleInbox: vi.fn(),
  markModuleInboxRead: vi.fn(),
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

const createPage = () => ({
  ...pageDefinition,
  data: structuredClone(pageDefinition.data),
  setData(this: { data: Record<string, unknown> }, update: Record<string, unknown>) {
    Object.assign(this.data, update);
  },
}) as unknown as PageDefinition & {
  data: Record<string, any>;
  onLoad: (query: Record<string, string | undefined>) => void;
  load: (background?: boolean) => Promise<void>;
  resolveJoin: (event: WechatMiniprogram.TouchEvent) => Promise<void>;
};

const joinItem = (status: 'pending' | 'approved') => ({
  itemId: `inbox_join_${status}`,
  moduleId: 'module_1',
  recipientUserId: 'user_1',
  type: 'join_application',
  title: '新的加入申请',
  content: '新成员申请加入',
  targetType: 'join_application',
  targetId: 'application_1',
  status: 'unread',
  createdAt: '2026-07-28T08:00:00+08:00',
  updatedAt: '2026-07-28T08:00:00+08:00',
  expireAt: '2026-07-29T08:00:00+08:00',
  application: { applicationId: 'application_1', status },
});

const makeupItem = (status: 'pending' | 'approved') => ({
  itemId: `inbox_makeup_${status}`,
  moduleId: 'module_1',
  recipientUserId: 'user_1',
  type: 'makeup_approval',
  title: status === 'pending' ? '待审批补卡' : '补卡已处理',
  content: '成员申请补卡',
  targetType: 'makeup_approval',
  targetId: 'approval_1',
  status: 'unread',
  createdAt: '2026-07-28T07:00:00+08:00',
  updatedAt: '2026-07-28T07:00:00+08:00',
  expireAt: '2026-07-29T07:00:00+08:00',
  approval: { approvalId: 'approval_1', status },
});

const historyItem = {
  itemId: 'inbox_member_exit',
  moduleId: 'module_1',
  recipientUserId: 'user_1',
  type: 'member_change',
  title: '成员退出',
  content: '成员已退出模块',
  targetType: 'member_instance',
  targetId: 'member_2',
  status: 'unread',
  createdAt: '2026-07-28T06:00:00+08:00',
  updatedAt: '2026-07-28T06:00:00+08:00',
  expireAt: '2026-08-28T06:00:00+08:00',
};

describe('module todo', () => {
  beforeEach(async () => {
    vi.resetModules();
    api.getModuleInbox.mockReset();
    api.markModuleInboxRead.mockReset();
    api.markModuleInboxRead.mockResolvedValue(undefined);
    api.resolveJoinApplication.mockReset();
    api.resolveMakeupApproval.mockReset();
    vi.stubGlobal('wx', {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      showToast: vi.fn(),
      navigateBack: vi.fn(),
    });
    vi.stubGlobal('Page', (definition: PageDefinition) => { pageDefinition = definition; });
    await import('../src/subpackages/module-todo/index');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the full module inbox, reads text cards, and keeps pending actions', async () => {
    api.getModuleInbox
      .mockResolvedValueOnce([joinItem('pending'), joinItem('approved'), makeupItem('pending'), makeupItem('approved'), historyItem])
      .mockResolvedValueOnce([joinItem('approved'), makeupItem('pending'), historyItem]);
    api.resolveJoinApplication.mockResolvedValue({ applicationId: 'application_1', status: 'approved' });

    const page = createPage();
    page.onLoad({ moduleId: 'module_1' });
    await page.load();

    expect(page.data.items.map((item: { itemId: string }) => item.itemId)).toEqual([
      'inbox_join_pending',
      'inbox_join_approved',
      'inbox_makeup_pending',
      'inbox_makeup_approved',
      'inbox_member_exit',
    ]);
    expect(api.markModuleInboxRead).toHaveBeenCalledTimes(3);
    expect(page.data.items.filter((item: { status: string }) => item.status === 'unread').map((item: { itemId: string }) => item.itemId)).toEqual([
      'inbox_join_pending',
      'inbox_makeup_pending',
    ]);

    await page.resolveJoin({
      currentTarget: { dataset: { application: 'application_1', action: 'approve' } },
    } as unknown as WechatMiniprogram.TouchEvent);

    expect(api.resolveJoinApplication).toHaveBeenCalledWith('application_1', 'approve');
    expect(page.data.items.map((item: { itemId: string }) => item.itemId)).toEqual([
      'inbox_join_approved',
      'inbox_makeup_pending',
      'inbox_member_exit',
    ]);
    expect(page.data.processingIds).toEqual([]);
  });
});
