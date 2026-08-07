import {
  addDiscoveryComment,
  blockDiscoveryUser,
  deleteDiscoveryComment,
  deleteDiscoveryPost,
  dismissDiscoveryPost,
  fetchDiscoveryPost,
  reportDiscoveryPost,
  setDiscoveryPostLiked,
  type DiscoveryComment,
  type DiscoveryPost,
} from '../../services/api';
import { presentDiscoveryPost, type DiscoveryPostPresentation } from '../../utils/discovery-presentation';

Page({
  data: {
    statusBarHeight: 24,
    postId: '',
    post: null as DiscoveryPostPresentation | null,
    comments: [] as DiscoveryComment[],
    loading: true,
    errorMessage: '',
    commentValue: '',
    inputFocus: false,
    sending: false,
    replyToCommentId: '',
    replyToName: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const postId = String(options.postId ?? '');
    this.setData({
      statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24,
      postId,
      inputFocus: options.focus === 'comment',
    });
    void this.load();
  },

  async load() {
    if (!this.data.postId) {
      this.setData({ loading: false, errorMessage: '这条动态不存在' });
      return;
    }
    this.setData({ loading: true, errorMessage: '' });
    try {
      const result = await fetchDiscoveryPost(this.data.postId);
      this.setData({ post: presentDiscoveryPost(result.post), comments: result.comments });
    } catch {
      this.setData({ errorMessage: '这条动态已不可见' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/discover/index' });
  },

  retryLoad() { void this.load(); },
  noop() {},

  async toggleLike(event: WechatMiniprogram.CustomEvent<{ liked: boolean }>) {
    const post = this.data.post;
    if (!post) return;
    const liked = event.detail.liked;
    const optimistic = presentDiscoveryPost({
      ...post,
      likedByViewer: liked,
      likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1)),
    } as DiscoveryPost);
    this.setData({ post: optimistic });
    try {
      const result = await setDiscoveryPostLiked(post.postId, liked);
      this.setData({ post: presentDiscoveryPost({ ...optimistic, ...result, likedByViewer: result.liked } as DiscoveryPost) });
      wx.setStorageSync('notemylife.discovery.refresh', true);
    } catch {
      this.setData({ post });
      wx.showToast({ title: '操作没有成功，请重试', icon: 'none' });
    }
  },

  focusComment() { this.setData({ inputFocus: true }); },

  updateComment(event: WechatMiniprogram.Input) {
    this.setData({ commentValue: event.detail.value });
  },

  replyComment(event: WechatMiniprogram.TouchEvent) {
    const commentId = String(event.currentTarget.dataset.id ?? '');
    const comment = this.data.comments.find((item) => item.commentId === commentId);
    if (!comment) return;
    this.setData({ replyToCommentId: comment.parentCommentId ?? comment.commentId, replyToName: comment.author.name, inputFocus: true });
  },

  cancelReply() {
    this.setData({ replyToCommentId: '', replyToName: '' });
  },

  async sendComment() {
    const content = this.data.commentValue.trim();
    if (!content || this.data.sending) return;
    this.setData({ sending: true });
    try {
      await addDiscoveryComment(this.data.postId, content, this.data.replyToCommentId || undefined);
      this.setData({ commentValue: '', replyToCommentId: '', replyToName: '', inputFocus: false });
      await this.load();
      wx.setStorageSync('notemylife.discovery.refresh', true);
    } catch {
      wx.showToast({ title: '评论没有发送成功', icon: 'none' });
    } finally {
      this.setData({ sending: false });
    }
  },

  async commentMore(event: WechatMiniprogram.TouchEvent) {
    const comment = this.data.comments.find((item) => item.commentId === String(event.currentTarget.dataset.id ?? ''));
    if (!comment?.author.isCurrentUser) return;
    try {
      await wx.showActionSheet({ itemList: ['删除评论'], alertText: '评论操作' });
      await deleteDiscoveryComment(comment.commentId);
      await this.load();
      wx.setStorageSync('notemylife.discovery.refresh', true);
    } catch (error) {
      if (!String((error as { errMsg?: string }).errMsg ?? '').includes('cancel')) {
        wx.showToast({ title: '删除没有成功', icon: 'none' });
      }
    }
  },

  openRecruitment(event: WechatMiniprogram.CustomEvent<{ recruitmentId: string }>) {
    if (event.detail.recruitmentId) {
      void wx.navigateTo({ url: `/subpackages/discover-recruitment/index?recruitmentId=${encodeURIComponent(event.detail.recruitmentId)}` });
    }
  },

  async openMore() {
    const post = this.data.post;
    if (!post) return;
    if (post.author.isCurrentUser) {
      try {
        await wx.showActionSheet({ itemList: ['删除动态'], alertText: '动态操作' });
        if (!(await wx.showModal({ title: '删除动态', content: '删除后无法恢复。', confirmColor: '#F65451' })).confirm) return;
        await deleteDiscoveryPost(post.postId);
        wx.setStorageSync('notemylife.discovery.refresh', true);
        this.goBack();
      } catch { /* User cancellation requires no feedback. */ }
      return;
    }
    const actions = ['不感兴趣', '举报', '屏蔽这位用户'];
    try {
      const choice = await wx.showActionSheet({ itemList: actions, alertText: '动态操作' });
      if (choice.tapIndex === 0) await dismissDiscoveryPost(post.postId);
      if (choice.tapIndex === 1) await reportDiscoveryPost(post.postId, 'other');
      if (choice.tapIndex === 2) await blockDiscoveryUser(post.author.userId);
      wx.setStorageSync('notemylife.discovery.refresh', true);
      if (choice.tapIndex !== 1) this.goBack();
      else wx.showToast({ title: '已提交举报', icon: 'success' });
    } catch { /* User cancellation requires no feedback. */ }
  },

  onShareAppMessage() {
    return {
      title: this.data.post ? `${this.data.post.author.name} 分享了一段生活记录` : '发现一段生活记录',
      path: `/subpackages/discover-post/index?postId=${encodeURIComponent(this.data.postId)}`,
    };
  },
});
