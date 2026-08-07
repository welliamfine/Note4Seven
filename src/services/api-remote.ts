export const MODULE_NAME_MAX_LENGTH = 10;
export const MODULE_DESCRIPTION_MAX_LENGTH = 200;
export const PROFILE_NICKNAME_MAX_LENGTH = 20;

export type {
  CreateModuleInput,
  GalleryItem,
  GalleryView,
  InvitePreview,
  MemberManagementView,
  MemoryFootprintItem,
  MemoryCollageAssetType,
  MemoryCollageBoardAsset,
  MemoryCollageItem,
  MemoryCollageStickerAsset,
  MemoryCollageView,
  MemoryModuleOption,
  MemoryReportMode,
  SaveMemoryCollageInput,
  SavedMemoryCollage,
  MemoryStickerItem,
  MemoryView,
  ModuleInboxView,
  NotificationView,
  PrivacyView,
  ProfileOverview,
  ReactionView,
  PendingStreakReward,
  ReceivedStreakRewards,
  RevealedStreakReward,
  RecycleModuleView,
  ReminderView,
  SaveStreakRewardRuleInput,
  StreakRewardPreview,
  StreakRewardRuleView,
  SaveRecordInput,
  SubmitMakeupInput,
  UpdateCurrentUserProfileInput,
  UpdateReminderInput,
} from './local-api';

export * from './remote-api';
export * from './discovery-api';

import { remoteRequest } from './transport-client';
import { initializeTracking } from './tracker';

export function initializeApi(): void {
  initializeTracking(async (events) => {
    await remoteRequest('/analytics/events', { method: 'POST', data: { events } });
  });
}
