import { createId } from '../utils/id';
import { remoteRequest } from './transport-client';

export type DiscoveryPostType = 'record' | 'calendar' | 'board' | 'easter_egg' | 'module_recruitment';

export interface DiscoveryAuthor {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isCurrentUser: boolean;
}

export interface DiscoveryCalendarRecord {
  recordDate: string;
  memberKey: string;
  memberName: string;
  stickerUrl: string;
}

export interface DiscoveryBoardItem {
  assetType: 'record_sticker' | 'decorative_sticker';
  name: string;
  imageUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
}

export interface DiscoverySnapshot {
  recordDate?: string;
  moduleName?: string;
  mediaVariant?: string;
  stickerUrl?: string;
  month?: string;
  members?: Array<{ memberKey: string; name: string; joinSequence: number; avatarUrl: string | null }>;
  records?: DiscoveryCalendarRecord[];
  reportMode?: 'week' | 'month';
  periodKey?: string;
  boardName?: string;
  boardUrl?: string | null;
  items?: DiscoveryBoardItem[];
  stage?: 'unlocked' | 'redeemed';
  resultType?: 'gift' | 'sticker';
  sponsorName?: string;
  streakDays?: number;
  title?: string;
  rewardText?: string;
  coverUrl?: string | null;
  unlockedAt?: string;
  redeemedAt?: string | null;
  recruitmentId?: string;
  moduleDescription?: string;
  mode?: 'solo' | 'group';
  recordPolicy?: 'strict' | 'relaxed';
  memberCount?: number;
  memberLimit?: number;
  openSlots?: number;
  publicDescription?: string;
  expireAt?: string;
  recruitmentStatus?: 'recruiting' | 'full' | 'expired' | 'closed';
}

export interface DiscoveryPost {
  postId: string;
  postType: DiscoveryPostType;
  author: DiscoveryAuthor;
  publicText: string;
  snapshot: DiscoverySnapshot;
  likeCount: number;
  commentCount: number;
  likedByViewer: boolean;
  publishedAt: string;
}

export interface DiscoveryComment {
  commentId: string;
  postId: string;
  parentCommentId: string | null;
  author: DiscoveryAuthor;
  replyToName: string | null;
  content: string;
  createdAt: string;
}

export interface DiscoveryFeed {
  items: DiscoveryPost[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface DiscoveryPostDetail {
  post: DiscoveryPost;
  comments: DiscoveryComment[];
}

export interface DiscoveryRecruitment {
  recruitmentId: string;
  postId: string;
  moduleName: string;
  moduleDescription: string;
  mode: 'solo' | 'group';
  recordPolicy: 'strict' | 'relaxed';
  publicDescription: string;
  memberCount: number;
  memberLimit: number;
  openSlots: number;
  status: 'recruiting' | 'full' | 'expired' | 'closed';
  expireAt: string;
  creator: DiscoveryAuthor;
  canApply: boolean;
}

export interface DiscoveryPublishSource {
  postType: Exclude<DiscoveryPostType, 'module_recruitment'>;
  sourceId: string;
  moduleId?: string;
  month?: string;
  stage?: 'unlocked' | 'redeemed';
}

export async function fetchDiscoveryFeed(cursor?: string, limit = 10): Promise<DiscoveryFeed> {
  const query = [`limit=${limit}`, ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&');
  return remoteRequest<DiscoveryFeed>(`/discovery/feed?${query}`);
}

export async function fetchDiscoveryPost(postId: string): Promise<DiscoveryPostDetail> {
  return remoteRequest<DiscoveryPostDetail>(`/discovery/posts/${postId}`);
}

export async function fetchDiscoveryPublishPreview(source: DiscoveryPublishSource): Promise<{
  postType: DiscoveryPublishSource['postType'];
  snapshot: DiscoverySnapshot;
  privacyNotice: string;
}> {
  const query = [
    `postType=${source.postType}`,
    `sourceId=${encodeURIComponent(source.sourceId)}`,
    ...(source.moduleId ? [`moduleId=${encodeURIComponent(source.moduleId)}`] : []),
    ...(source.month ? [`month=${encodeURIComponent(source.month)}`] : []),
    ...(source.stage ? [`stage=${source.stage}`] : []),
  ].join('&');
  return remoteRequest(`/discovery/publish-preview?${query}`);
}

export async function publishDiscoveryPost(
  source: DiscoveryPublishSource,
  publicText: string,
): Promise<{ postId: string; status: string }> {
  return remoteRequest('/discovery/posts', {
    method: 'POST',
    data: { ...source, publicText, clientRequestId: createId('discover') },
  });
}

export async function publishDiscoveryRecruitment(input: {
  moduleId: string;
  publicDescription: string;
  durationDays: 1 | 3 | 7;
}): Promise<{ postId: string; recruitmentId: string; status: string }> {
  return remoteRequest('/discovery/recruitments', {
    method: 'POST',
    data: { ...input, clientRequestId: createId('recruit') },
  });
}

export async function fetchDiscoveryRecruitmentPreview(moduleId: string): Promise<{
  moduleId: string;
  moduleName: string;
  moduleDescription: string;
  mode: 'solo' | 'group';
  recordPolicy: 'strict' | 'relaxed';
  memberCount: number;
  memberLimit: number;
  openSlots: number;
  canRecruit: boolean;
}> {
  return remoteRequest(`/discovery/recruitment-preview?moduleId=${encodeURIComponent(moduleId)}`);
}

export async function fetchDiscoveryRecruitment(recruitmentId: string): Promise<DiscoveryRecruitment> {
  return remoteRequest(`/discovery/recruitments/${recruitmentId}`);
}

export async function applyToDiscoveryRecruitment(recruitmentId: string): Promise<{ status: string }> {
  return remoteRequest(`/discovery/recruitments/${recruitmentId}/applications`, {
    method: 'POST',
    data: { clientRequestId: createId('recruit_apply') },
  });
}

export async function setDiscoveryPostLiked(postId: string, liked: boolean): Promise<{ likeCount: number; liked: boolean }> {
  return remoteRequest(`/discovery/posts/${postId}/like`, {
    method: 'PUT',
    data: { liked, clientRequestId: createId('discover_like') },
  });
}

export async function addDiscoveryComment(
  postId: string,
  content: string,
  parentCommentId?: string,
): Promise<{ commentId: string; commentCount: number }> {
  return remoteRequest(`/discovery/posts/${postId}/comments`, {
    method: 'POST',
    data: { content, parentCommentId, clientRequestId: createId('discover_comment') },
  });
}

export async function deleteDiscoveryComment(commentId: string): Promise<{ commentCount: number }> {
  return remoteRequest(`/discovery/comments/${commentId}`, {
    method: 'DELETE',
    data: { clientRequestId: createId('discover_comment_delete') },
  });
}

export async function deleteDiscoveryPost(postId: string): Promise<void> {
  await remoteRequest(`/discovery/posts/${postId}`, {
    method: 'DELETE',
    data: { clientRequestId: createId('discover_delete') },
  });
}

export async function dismissDiscoveryPost(postId: string): Promise<void> {
  await remoteRequest(`/discovery/posts/${postId}/dismiss`, {
    method: 'POST',
    data: { clientRequestId: createId('discover_dismiss') },
  });
}

export async function blockDiscoveryUser(userId: string): Promise<void> {
  await remoteRequest(`/discovery/users/${userId}/block`, {
    method: 'POST',
    data: { clientRequestId: createId('discover_block') },
  });
}

export async function reportDiscoveryPost(
  postId: string,
  reason: 'spam' | 'abuse' | 'privacy' | 'illegal' | 'other',
  detail = '',
): Promise<void> {
  await remoteRequest(`/discovery/posts/${postId}/report`, {
    method: 'POST',
    data: { reason, detail, clientRequestId: createId('discover_report') },
  });
}

export async function closeDiscoveryRecruitment(recruitmentId: string): Promise<void> {
  await remoteRequest(`/discovery/recruitments/${recruitmentId}/close`, {
    method: 'POST',
    data: { clientRequestId: createId('recruit_close') },
  });
}

export async function redeemStreakRewardForDiscovery(rewardDrawId: string): Promise<void> {
  await remoteRequest(`/streak-reward-draws/${rewardDrawId}/redeem`, {
    method: 'POST',
    data: { clientRequestId: createId('reward_redeem') },
  });
}
