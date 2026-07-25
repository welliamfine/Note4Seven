import type { InvitePreview } from '../../services/api';
import { getInvitePreview, submitJoinApplication } from '../../services/api';
import { track } from '../../services/tracker';

Page({
  data: { statusBarHeight: 24, inviteId: '', loading: true, preview: null as InvitePreview | null, submitting: false, resultText: '' },
  onLoad(query: Record<string, string | undefined>) {
    this.setData({ inviteId: query.inviteId ?? decodeURIComponent(query.scene ?? ''), statusBarHeight: wx.getWindowInfo?.().statusBarHeight ?? 24 });
    void this.load();
  },
  async load() {
    try {
      const preview = await getInvitePreview(this.data.inviteId);
      this.setData({ preview, inviteId: preview.invite.inviteId, loading: false });
      track('invite_landing_view', { inviteId: this.data.inviteId, valid: preview.valid });
    } catch {
      this.setData({ loading: false, resultText: '这个邀请不存在或已经失效。' });
    }
  },
  goBack() { void wx.navigateBack(); },
  async apply() {
    if (this.data.submitting || !this.data.preview?.valid) return;
    this.setData({ submitting: true });
    try {
      const result = await submitJoinApplication(this.data.inviteId);
      this.setData({ submitting: false, resultText: result === 'already_member' ? '你已经是这个模块的成员。' : '申请已发送，等待创建者处理。' });
      track('join_application_submit', { inviteId: this.data.inviteId, result: result === 'already_member' ? 'already_member' : 'success' });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const message = code === 'MODULE_FULL' ? '成员已满，暂时无法申请。' : code === 'JOIN_COOLDOWN' ? '申请被拒后24小时内不能再次申请。' : '申请提交失败，请稍后再试。';
      this.setData({ submitting: false, resultText: message });
    }
  },
});
