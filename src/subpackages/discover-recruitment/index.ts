import {
  applyToDiscoveryRecruitment,
  closeDiscoveryRecruitment,
  fetchDiscoveryRecruitment,
  type DiscoveryRecruitment,
} from '../../services/api';

Page({
  data: {
    statusBarHeight: 24,
    recruitmentId: '',
    recruitment: null as DiscoveryRecruitment | null,
    loading: true,
    errorMessage: '',
    applying: false,
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
      recruitmentId: String(options.recruitmentId ?? ''),
    });
    void this.load();
  },

  async load() {
    this.setData({ loading: true, errorMessage: '' });
    try {
      this.setData({ recruitment: await fetchDiscoveryRecruitment(this.data.recruitmentId) });
    } catch {
      this.setData({ errorMessage: '这条招募已不可见' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/discover/index' });
  },

  retryLoad() { void this.load(); },

  async apply() {
    const recruitment = this.data.recruitment;
    if (!recruitment?.canApply || this.data.applying) return;
    this.setData({ applying: true });
    try {
      const result = await applyToDiscoveryRecruitment(recruitment.recruitmentId);
      wx.showModal({
        title: result.status === 'already_member' ? '你已经在模块中' : '申请已提交',
        content: result.status === 'already_member' ? '无需再次申请。' : '创建者会在成员管理中处理你的申请。',
        showCancel: false,
      });
      await this.load();
    } catch {
      wx.showToast({ title: '申请没有提交成功', icon: 'none' });
    } finally {
      this.setData({ applying: false });
    }
  },

  async closeRecruitment() {
    const recruitment = this.data.recruitment;
    if (!recruitment?.creator.isCurrentUser) return;
    const result = await wx.showModal({
      title: '结束招募',
      content: '结束后，其他人将无法再从这条动态申请加入。',
      confirmColor: '#F65451',
    });
    if (!result.confirm) return;
    try {
      await closeDiscoveryRecruitment(recruitment.recruitmentId);
      wx.setStorageSync('notemylife.discovery.refresh', true);
      await this.load();
    } catch {
      wx.showToast({ title: '暂时无法结束招募', icon: 'none' });
    }
  },

  onShareAppMessage() {
    const recruitment = this.data.recruitment;
    return {
      title: recruitment ? `${recruitment.creator.name} 邀请你一起记录「${recruitment.moduleName}」` : '邀请你一起记录生活',
      path: `/subpackages/discover-recruitment/index?recruitmentId=${encodeURIComponent(this.data.recruitmentId)}`,
    };
  },
});
