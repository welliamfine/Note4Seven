import {
  blockDiscoveryUser,
  deleteDiscoveryPost,
  dismissDiscoveryPost,
  fetchDiscoveryFeed,
  reportDiscoveryPost,
  setDiscoveryPostLiked,
  type DiscoveryPost,
} from '../../services/api';
import { track } from '../../services/tracker';
import { presentDiscoveryPost, type DiscoveryPostPresentation } from '../../utils/discovery-presentation';

let loadToken = 0;

Page({
  data: {
    statusBarHeight: 24,
    items: [] as DiscoveryPostPresentation[],
    nextCursor: null as string | null,
    hasMore: false,
    loading: true,
    loadingMore: false,
    errorMessage: '',
    moreOpen: false,
    selectedPost: null as DiscoveryPostPresentation | null,
  },

  onLoad() {
    this.setData({ statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.load(true);
  },

  onShow() {
    this.getTabBar?.()?.setData({ selected: 2, hidden: this.data.moreOpen });
    if (wx.getStorageSync('notemylife.discovery.refresh')) {
      wx.removeStorageSync('notemylife.discovery.refresh');
      void this.load(true);
    }
    track('discover_view', { pageVariant: 'community' });
  },

  async load(reset: boolean) {
    if (this.data.loadingMore && !reset) return;
    const token = ++loadToken;
    this.setData(reset
      ? { loading: true, errorMessage: '' }
      : { loadingMore: true, errorMessage: '' });
    try {
      const result = await fetchDiscoveryFeed(reset ? undefined : this.data.nextCursor ?? undefined);
      if (token !== loadToken) return;
      const incoming = result.items.map((item) => presentDiscoveryPost(item));
      this.setData({
        items: reset ? incoming : [...this.data.items, ...incoming],
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch {
      if (token !== loadToken) return;
      this.setData({ errorMessage: '发现页暂时没有加载出来' });
    } finally {
      if (token === loadToken) {
        this.setData({ loading: false, loadingMore: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  onPullDownRefresh() {
    void this.load(true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) void this.load(false);
  },

  retryLoad() {
    void this.load(true);
  },

  openPost(event: WechatMiniprogram.CustomEvent<{ postId: string }>) {
    void wx.navigateTo({ url: `/subpackages/discover-post/index?postId=${encodeURIComponent(event.detail.postId)}` });
  },

  openComments(event: WechatMiniprogram.CustomEvent<{ postId: string }>) {
    void wx.navigateTo({ url: `/subpackages/discover-post/index?postId=${encodeURIComponent(event.detail.postId)}&focus=comment` });
  },

  openRecruitment(event: WechatMiniprogram.CustomEvent<{ recruitmentId: string }>) {
    if (!event.detail.recruitmentId) return;
    void wx.navigateTo({ url: `/subpackages/discover-recruitment/index?recruitmentId=${encodeURIComponent(event.detail.recruitmentId)}` });
  },

  async toggleLike(event: WechatMiniprogram.CustomEvent<{ postId: string; liked: boolean }>) {
    const { postId, liked } = event.detail;
    const before = this.data.items;
    this.updatePost(postId, (post: DiscoveryPostPresentation) => presentDiscoveryPost({
      ...post,
      likedByViewer: liked,
      likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1)),
    } as DiscoveryPost));
    try {
      const result = await setDiscoveryPostLiked(postId, liked);
      this.updatePost(postId, (post: DiscoveryPostPresentation) => presentDiscoveryPost({
        ...post,
        likedByViewer: result.liked,
        likeCount: result.likeCount,
      } as DiscoveryPost));
    } catch {
      this.setData({ items: before });
      wx.showToast({ title: '操作没有成功，请重试', icon: 'none' });
    }
  },

  updatePost(postId: string, update: (post: DiscoveryPostPresentation) => DiscoveryPostPresentation) {
    this.setData({ items: this.data.items.map((post) => post.postId === postId ? update(post) : post) });
  },

  openMore(event: WechatMiniprogram.CustomEvent<{ post: DiscoveryPostPresentation }>) {
    this.setData({ moreOpen: true, selectedPost: event.detail.post });
    this.getTabBar?.()?.setData({ selected: 2, hidden: true });
  },

  closeMore() {
    this.setData({ moreOpen: false, selectedPost: null });
    this.getTabBar?.()?.setData({ selected: 2, hidden: false });
  },

  stopPropagation() {},

  async dismissSelected() {
    const post = this.data.selectedPost;
    if (!post) return;
    this.closeMore();
    try {
      await dismissDiscoveryPost(post.postId);
      this.setData({ items: this.data.items.filter((item) => item.postId !== post.postId) });
    } catch {
      wx.showToast({ title: '暂时无法减少这类内容', icon: 'none' });
    }
  },

  async blockSelected() {
    const post = this.data.selectedPost;
    if (!post) return;
    const confirmed = await confirm(`屏蔽 ${post.author.name} 后，你们将无法在发现页看到彼此。`);
    if (!confirmed) return;
    this.closeMore();
    try {
      await blockDiscoveryUser(post.author.userId);
      this.setData({ items: this.data.items.filter((item) => item.author.userId !== post.author.userId) });
    } catch {
      wx.showToast({ title: '屏蔽没有成功，请重试', icon: 'none' });
    }
  },

  async reportSelected() {
    const post = this.data.selectedPost;
    if (!post) return;
    const reasons = [
      { label: '垃圾广告', value: 'spam' as const },
      { label: '辱骂或骚扰', value: 'abuse' as const },
      { label: '泄露隐私', value: 'privacy' as const },
      { label: '违法违规', value: 'illegal' as const },
      { label: '其他', value: 'other' as const },
    ];
    this.closeMore();
    try {
      const choice = await wx.showActionSheet({ itemList: reasons.map((item) => item.label) });
      await reportDiscoveryPost(post.postId, reasons[choice.tapIndex].value);
      wx.showToast({ title: '已提交举报', icon: 'success' });
    } catch (error) {
      if (String((error as { errMsg?: string }).errMsg ?? '').includes('cancel')) return;
      wx.showToast({ title: '举报没有提交成功', icon: 'none' });
    }
  },

  async deleteSelected() {
    const post = this.data.selectedPost;
    if (!post) return;
    if (!await confirm('删除后，这条动态和招募入口都会停止公开。')) return;
    this.closeMore();
    try {
      await deleteDiscoveryPost(post.postId);
      this.setData({ items: this.data.items.filter((item) => item.postId !== post.postId) });
    } catch {
      wx.showToast({ title: '删除没有成功，请重试', icon: 'none' });
    }
  },

  onShareAppMessage(event: WechatMiniprogram.Page.IShareAppMessageOption) {
    const postId = String(event.target?.dataset?.postId ?? '');
    const post = this.data.items.find((item) => item.postId === postId);
    return {
      title: post ? `${post.author.name} 分享了一段生活记录` : '发现一段生活记录',
      path: `/subpackages/discover-post/index?postId=${encodeURIComponent(postId)}`,
    };
  },
});

function confirm(content: string): Promise<boolean> {
  return wx.showModal({ title: '请确认', content, confirmColor: '#F65451' })
    .then((result) => result.confirm);
}
