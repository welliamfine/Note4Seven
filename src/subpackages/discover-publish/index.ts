import {
  fetchDiscoveryPublishPreview,
  fetchDiscoveryRecruitmentPreview,
  publishDiscoveryPost,
  publishDiscoveryRecruitment,
  type DiscoveryPublishSource,
  type DiscoverySnapshot,
} from '../../services/api';
import { boardItemStyle, buildCalendarCells, type DiscoveryCalendarCell } from '../../utils/discovery-presentation';

interface RecruitmentPreview {
  moduleId: string;
  moduleName: string;
  moduleDescription: string;
  mode: 'solo' | 'group';
  recordPolicy: 'strict' | 'relaxed';
  memberCount: number;
  memberLimit: number;
  openSlots: number;
  canRecruit: boolean;
}

Page({
  data: {
    statusBarHeight: 24,
    mode: 'post' as 'post' | 'recruitment',
    source: null as DiscoveryPublishSource | null,
    snapshot: null as DiscoverySnapshot | null,
    privacyNotice: '',
    calendarCells: [] as DiscoveryCalendarCell[],
    boardItems: [] as Array<Record<string, unknown> & { style: string }>,
    recruitment: null as RecruitmentPreview | null,
    publicText: '',
    durationDays: 3 as 1 | 3 | 7,
    loading: true,
    publishing: false,
    errorMessage: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const mode = options.mode === 'recruitment' ? 'recruitment' : 'post';
    const source = mode === 'post' ? {
      postType: String(options.postType ?? '') as DiscoveryPublishSource['postType'],
      sourceId: String(options.sourceId ?? ''),
      moduleId: options.moduleId,
      month: options.month,
      stage: options.stage === 'redeemed' ? 'redeemed' as const : options.stage === 'unlocked' ? 'unlocked' as const : undefined,
    } : null;
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
      mode,
      source,
    });
    void this.load(options.moduleId);
  },

  async load(recruitmentModuleId?: string) {
    this.setData({ loading: true, errorMessage: '' });
    try {
      if (this.data.mode === 'recruitment') {
        if (!recruitmentModuleId) throw new Error('MODULE_REQUIRED');
        this.setData({ recruitment: await fetchDiscoveryRecruitmentPreview(recruitmentModuleId) });
      } else if (this.data.source) {
        const preview = await fetchDiscoveryPublishPreview(this.data.source);
        this.setData({
          snapshot: preview.snapshot,
          privacyNotice: preview.privacyNotice,
          calendarCells: buildCalendarCells(preview.snapshot.month ?? '', preview.snapshot.records ?? []),
          boardItems: (preview.snapshot.items ?? []).map((item) => ({ ...item, style: boardItemStyle(item) })),
        });
      } else {
        throw new Error('SOURCE_REQUIRED');
      }
    } catch {
      this.setData({ errorMessage: '这份内容暂时不能分享到发现' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() { wx.navigateBack(); },
  retryLoad() { void this.load(this.data.recruitment?.moduleId); },

  updatePublicText(event: WechatMiniprogram.Input) {
    this.setData({ publicText: event.detail.value });
  },

  chooseDuration(event: WechatMiniprogram.TouchEvent) {
    this.setData({ durationDays: Number(event.currentTarget.dataset.days) as 1 | 3 | 7 });
  },

  async publish() {
    if (this.data.publishing || this.data.loading || this.data.errorMessage) return;
    this.setData({ publishing: true });
    try {
      let postId: string;
      if (this.data.mode === 'recruitment') {
        const recruitment = this.data.recruitment;
        const publicDescription = this.data.publicText.trim();
        if (!recruitment?.canRecruit || !publicDescription) {
          wx.showToast({ title: publicDescription ? '当前模块不能发起招募' : '请填写招募说明', icon: 'none' });
          return;
        }
        const result = await publishDiscoveryRecruitment({
          moduleId: recruitment.moduleId,
          publicDescription,
          durationDays: this.data.durationDays,
        });
        postId = result.postId;
      } else {
        if (!this.data.source) return;
        const result = await publishDiscoveryPost(this.data.source, this.data.publicText);
        postId = result.postId;
      }
      wx.setStorageSync('notemylife.discovery.refresh', true);
      await wx.redirectTo({ url: `/subpackages/discover-post/index?postId=${encodeURIComponent(postId)}` });
    } catch (error) {
      const code = (error as { code?: string }).code ?? String((error as Error).message ?? '');
      const title = code.includes('DUP') || code.includes('CONFLICT') ? '这份内容已经发布过' : '发布没有成功，请重试';
      wx.showToast({ title, icon: 'none' });
    } finally {
      this.setData({ publishing: false });
    }
  },
});
