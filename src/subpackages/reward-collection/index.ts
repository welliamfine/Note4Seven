import { getReceivedStreakRewards, type RevealedStreakReward } from '../../services/api';

type RewardFilter = 'all' | 'gift' | 'sticker';
type CollectionItem = RevealedStreakReward & { dateRange: string };

Page({
  data: {
    moduleId: '',
    statusBarHeight: 24,
    loading: true,
    filter: 'all' as RewardFilter,
    items: [] as CollectionItem[],
    visibleItems: [] as CollectionItem[],
    counts: { all: 0, gift: 0, sticker: 0 },
  },

  onLoad(query: Record<string, string | undefined>) {
    if (!query.moduleId) {
      wx.showToast({ title: '模块不存在', icon: 'none' });
      void wx.navigateBack();
      return;
    }
    this.setData({
      moduleId: query.moduleId,
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
    });
    void this.loadRewards();
  },

  async loadRewards() {
    try {
      const result = await getReceivedStreakRewards(this.data.moduleId);
      const items = result.items.map((item) => ({
        ...item,
        dateRange: `${item.windowStart.replace(/-/g, '.')} — ${item.windowEnd.replace(/-/g, '.')}`,
      }));
      this.setData({ items, visibleItems: items, counts: result.counts, loading: false });
    } catch (error) {
      console.error('[streak-reward] collection failed', error);
      this.setData({ loading: false });
      wx.showToast({ title: '礼物合集加载失败', icon: 'none' });
    }
  },

  chooseFilter(event: WechatMiniprogram.TouchEvent) {
    const filter = String(event.currentTarget.dataset.filter) as RewardFilter;
    if (!['all', 'gift', 'sticker'].includes(filter)) return;
    this.setData({
      filter,
      visibleItems: filter === 'all' ? this.data.items : this.data.items.filter((item) => item.resultType === filter),
    });
  },

  goBack() { void wx.navigateBack(); },
});
