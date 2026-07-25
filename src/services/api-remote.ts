export const MODULE_NAME_MAX_LENGTH = 10;
export const MODULE_DESCRIPTION_MAX_LENGTH = 200;
export const PROFILE_NICKNAME_MAX_LENGTH = 20;

export type {
  CreateModuleInput,
  GalleryItem,
  GalleryView,
  InvitePreview,
  MemberManagementView,
  MemoryModuleOption,
  MemoryStickerItem,
  MemoryView,
  ModuleInboxView,
  NotificationView,
  PrivacyView,
  ProfileOverview,
  ReactionView,
  RecycleModuleView,
  ReminderView,
  SaveRecordInput,
  SubmitMakeupInput,
  UpdateCurrentUserProfileInput,
  UpdateReminderInput,
} from './local-api';

export * from './remote-api';

export function initializeApi(): void {}
