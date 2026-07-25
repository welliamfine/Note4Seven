CREATE TABLE IF NOT EXISTS user_account (
  user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  open_id VARCHAR(64) NOT NULL,
  union_id VARCHAR(64) NULL,
  nickname VARCHAR(64) NOT NULL,
  avatar_file_key VARCHAR(512) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_user_open_id (open_id),
  KEY idx_user_union_id (union_id),
  KEY idx_user_status_updated (status, updated_at),
  CONSTRAINT chk_user_status CHECK (status IN ('active', 'deletion_pending', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_session (
  session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_auth_session_token (token_hash),
  KEY idx_auth_session_user (user_id, expires_at),
  KEY idx_auth_session_expiry (expires_at, revoked_at),
  CONSTRAINT fk_auth_session_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS module_template (
  template_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_code VARCHAR(40) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  name VARCHAR(40) NOT NULL,
  description VARCHAR(300) NULL,
  sort_order INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (template_id),
  UNIQUE KEY uq_module_template_code (template_code),
  KEY idx_module_template_status_sort (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS life_module (
  module_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(40) NOT NULL,
  description VARCHAR(300) NULL,
  template_id BIGINT UNSIGNED NULL,
  creator_user_id BIGINT UNSIGNED NOT NULL,
  creator_member_instance_id BIGINT UNSIGNED NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'solo',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  member_limit TINYINT UNSIGNED NOT NULL DEFAULT 4,
  active_member_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  next_join_sequence INT UNSIGNED NOT NULL DEFAULT 2,
  group_activated_at DATETIME(3) NULL,
  last_activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  recycle_expire_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (module_id),
  KEY idx_module_creator_status (creator_user_id, status),
  KEY idx_module_recycle (status, recycle_expire_at),
  KEY idx_module_activity (last_activity_at),
  CONSTRAINT fk_module_template FOREIGN KEY (template_id) REFERENCES module_template(template_id),
  CONSTRAINT fk_module_creator_user FOREIGN KEY (creator_user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_module_mode CHECK (mode IN ('solo', 'group')),
  CONSTRAINT chk_module_status CHECK (status IN ('active', 'pending_delete', 'deleted')),
  CONSTRAINT chk_module_member_limit CHECK (member_limit = 4),
  CONSTRAINT chk_module_member_count CHECK (active_member_count BETWEEN 0 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS module_member (
  member_instance_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  join_sequence INT UNSIGNED NOT NULL,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at DATETIME(3) NULL,
  leave_reason VARCHAR(32) NULL,
  nickname_snapshot VARCHAR(64) NOT NULL,
  avatar_file_key_snapshot VARCHAR(512) NULL,
  active_user_key VARCHAR(128) GENERATED ALWAYS AS (
    IF(status = 'active', CONCAT(module_id, ':', user_id), NULL)
  ) STORED,
  active_creator_key VARCHAR(128) GENERATED ALWAYS AS (
    IF(status = 'active' AND role = 'creator', CAST(module_id AS CHAR), NULL)
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (member_instance_id),
  UNIQUE KEY uq_member_join_sequence (module_id, join_sequence),
  UNIQUE KEY uq_member_active_user (active_user_key),
  UNIQUE KEY uq_member_active_creator (active_creator_key),
  KEY idx_member_module_status (module_id, status, join_sequence),
  KEY idx_member_user_status (user_id, status),
  CONSTRAINT fk_member_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_member_role CHECK (role IN ('creator', 'member')),
  CONSTRAINT chk_member_status CHECK (status IN ('active', 'exited', 'removed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_module_preference (
  preference_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  module_id BIGINT UNSIGNED NOT NULL,
  is_pinned TINYINT(1) NOT NULL DEFAULT 0,
  pin_order INT NULL,
  home_group_collapsed_snapshot JSON NULL,
  last_viewed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (preference_id),
  UNIQUE KEY uq_preference_user_module (user_id, module_id),
  KEY idx_preference_home (user_id, is_pinned, updated_at),
  CONSTRAINT fk_preference_user FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_preference_module FOREIGN KEY (module_id) REFERENCES life_module(module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_asset (
  media_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  module_id BIGINT UNSIGNED NULL,
  member_instance_id BIGINT UNSIGNED NULL,
  purpose VARCHAR(24) NOT NULL,
  source_type VARCHAR(16) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  sha256 CHAR(64) NULL,
  original_file_key VARCHAR(512) NULL,
  thumbnail_file_key VARCHAR(512) NULL,
  sticker_file_key VARCHAR(512) NULL,
  sticker_thumbnail_file_key VARCHAR(512) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'created',
  cutout_status VARCHAR(24) NOT NULL DEFAULT 'not_started',
  content_check_status VARCHAR(24) NOT NULL DEFAULT 'not_started',
  content_check_trace_id VARCHAR(128) NULL,
  cutout_provider VARCHAR(32) NULL,
  cutout_task_id VARCHAR(128) NULL,
  processing_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  failure_code VARCHAR(64) NULL,
  failure_message VARCHAR(255) NULL,
  ready_at DATETIME(3) NULL,
  abandoned_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (media_id),
  KEY idx_media_owner_created (owner_user_id, created_at),
  KEY idx_media_status_updated (status, updated_at),
  KEY idx_media_cutout_updated (cutout_status, updated_at),
  KEY idx_media_cutout_task (cutout_task_id),
  CONSTRAINT fk_media_owner FOREIGN KEY (owner_user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_media_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_media_member FOREIGN KEY (member_instance_id) REFERENCES module_member(member_instance_id),
  CONSTRAINT chk_media_file_size CHECK (file_size <= 10485760),
  CONSTRAINT chk_media_status CHECK (status IN ('created', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'abandoned')),
  CONSTRAINT chk_media_cutout_status CHECK (cutout_status IN ('not_started', 'queued', 'processing', 'succeeded', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS life_record (
  record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  member_instance_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  record_date DATE NOT NULL,
  source VARCHAR(16) NOT NULL,
  status VARCHAR(24) NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  remark VARCHAR(500) NULL,
  display_name_snapshot VARCHAR(64) NOT NULL,
  avatar_file_key_snapshot VARCHAR(512) NULL,
  join_sequence_snapshot INT UNSIGNED NOT NULL,
  client_request_id VARCHAR(64) NOT NULL,
  first_effective_at DATETIME(3) NULL,
  approved_at DATETIME(3) NULL,
  locked_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  effective_daily_key VARCHAR(160) GENERATED ALWAYS AS (
    IF(status IN ('pending', 'active', 'locked'), CONCAT(module_id, ':', member_instance_id, ':', record_date), NULL)
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (record_id),
  UNIQUE KEY uq_record_user_request (user_id, client_request_id),
  UNIQUE KEY uq_record_effective_daily (effective_daily_key),
  KEY idx_record_module_date_status (module_id, record_date, status),
  KEY idx_record_member_date (member_instance_id, record_date),
  KEY idx_record_effective_order (module_id, record_date, first_effective_at),
  KEY idx_record_media (media_id),
  CONSTRAINT fk_record_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_record_member FOREIGN KEY (member_instance_id) REFERENCES module_member(member_instance_id),
  CONSTRAINT fk_record_user FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_record_media FOREIGN KEY (media_id) REFERENCES media_asset(media_id),
  CONSTRAINT chk_record_source CHECK (source IN ('normal', 'makeup')),
  CONSTRAINT chk_record_status CHECK (status IN ('pending', 'active', 'locked', 'rejected', 'expired', 'cancelled', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS record_revision (
  revision_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id BIGINT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  remark VARCHAR(500) NULL,
  changed_by_user_id BIGINT UNSIGNED NOT NULL,
  change_type VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revision_id),
  UNIQUE KEY uq_record_revision (record_id, revision_no),
  CONSTRAINT fk_revision_record FOREIGN KEY (record_id) REFERENCES life_record(record_id),
  CONSTRAINT fk_revision_media FOREIGN KEY (media_id) REFERENCES media_asset(media_id),
  CONSTRAINT fk_revision_user FOREIGN KEY (changed_by_user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reaction (
  reaction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  reactor_user_id BIGINT UNSIGNED NOT NULL,
  reactor_member_instance_id BIGINT UNSIGNED NOT NULL,
  emoji_code VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL,
  reactor_name_snapshot VARCHAR(64) NOT NULL,
  reactor_avatar_file_key_snapshot VARCHAR(512) NULL,
  cancelled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (reaction_id),
  UNIQUE KEY uq_reaction_record_member (record_id, reactor_member_instance_id),
  KEY idx_reaction_record_status (record_id, status),
  KEY idx_reaction_user_created (reactor_user_id, created_at),
  CONSTRAINT fk_reaction_record FOREIGN KEY (record_id) REFERENCES life_record(record_id),
  CONSTRAINT fk_reaction_member FOREIGN KEY (reactor_member_instance_id) REFERENCES module_member(member_instance_id),
  CONSTRAINT chk_reaction_status CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT chk_reaction_emoji CHECK (emoji_code IN ('heart', 'like', 'laugh', 'yummy', 'hug', 'cheer'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS makeup_approval (
  approval_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  applicant_user_id BIGINT UNSIGNED NOT NULL,
  applicant_member_instance_id BIGINT UNSIGNED NOT NULL,
  target_date DATE NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL,
  expire_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  resolved_by_user_id BIGINT UNSIGNED NULL,
  resolved_by_member_instance_id BIGINT UNSIGNED NULL,
  resolution_reason VARCHAR(64) NULL,
  pending_makeup_key VARCHAR(180) GENERATED ALWAYS AS (
    IF(status = 'pending', CONCAT(module_id, ':', applicant_member_instance_id, ':', target_date), NULL)
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (approval_id),
  UNIQUE KEY uq_makeup_record (record_id),
  UNIQUE KEY uq_makeup_pending (pending_makeup_key),
  KEY idx_makeup_module_status_expiry (module_id, status, expire_at),
  KEY idx_makeup_applicant_date (applicant_member_instance_id, target_date),
  CONSTRAINT fk_makeup_record FOREIGN KEY (record_id) REFERENCES life_record(record_id),
  CONSTRAINT fk_makeup_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT chk_makeup_status CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_action (
  action_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  approval_id BIGINT UNSIGNED NOT NULL,
  operator_user_id BIGINT UNSIGNED NOT NULL,
  operator_member_instance_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(16) NOT NULL,
  result VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (action_id),
  KEY idx_approval_action_approval (approval_id, created_at),
  KEY idx_approval_action_operator (operator_user_id, created_at),
  CONSTRAINT fk_approval_action_approval FOREIGN KEY (approval_id) REFERENCES makeup_approval(approval_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invite_token (
  invite_token_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_by_member_instance_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix VARCHAR(12) NULL,
  status VARCHAR(24) NOT NULL,
  mini_program_code_file_key VARCHAR(512) NULL,
  expire_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (invite_token_id),
  UNIQUE KEY uq_invite_token_hash (token_hash),
  KEY idx_invite_module_status_expiry (module_id, status, expire_at),
  KEY idx_invite_expiry_status (expire_at, status),
  CONSTRAINT fk_invite_module FOREIGN KEY (module_id) REFERENCES life_module(module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS join_application (
  application_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  applicant_user_id BIGINT UNSIGNED NOT NULL,
  invite_token_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL,
  applicant_name_snapshot VARCHAR(64) NOT NULL,
  applicant_avatar_file_key_snapshot VARCHAR(512) NULL,
  expire_at DATETIME(3) NOT NULL,
  reapply_allowed_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  resolved_by_user_id BIGINT UNSIGNED NULL,
  result_member_instance_id BIGINT UNSIGNED NULL,
  resolution_reason VARCHAR(64) NULL,
  pending_join_key VARCHAR(128) GENERATED ALWAYS AS (
    IF(status = 'pending', CONCAT(module_id, ':', applicant_user_id), NULL)
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (application_id),
  UNIQUE KEY uq_join_pending (pending_join_key),
  KEY idx_join_module_status_created (module_id, status, created_at),
  KEY idx_join_applicant_module_status (applicant_user_id, module_id, status),
  KEY idx_join_expiry (status, expire_at),
  CONSTRAINT fk_join_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_join_invite FOREIGN KEY (invite_token_id) REFERENCES invite_token(invite_token_id),
  CONSTRAINT chk_join_status CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification (
  notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content VARCHAR(500) NULL,
  module_id BIGINT UNSIGNED NULL,
  target_type VARCHAR(32) NULL,
  target_id BIGINT UNSIGNED NULL,
  record_date DATE NULL,
  page_type VARCHAR(40) NULL,
  action_type VARCHAR(32) NOT NULL DEFAULT 'none',
  action_status VARCHAR(20) NOT NULL DEFAULT 'none',
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) NULL,
  expired_at DATETIME(3) NULL,
  dedupe_key VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (notification_id),
  UNIQUE KEY uq_notification_dedupe (user_id, dedupe_key),
  KEY idx_notification_user_unread (user_id, is_read, created_at),
  KEY idx_notification_user_type (user_id, type, created_at),
  KEY idx_notification_target (target_type, target_id),
  CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS module_inbox_item (
  item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  recipient_user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content VARCHAR(500) NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  record_date DATE NULL,
  status VARCHAR(20) NOT NULL,
  dedupe_key VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  expire_at DATETIME(3) NOT NULL,
  PRIMARY KEY (item_id),
  UNIQUE KEY uq_inbox_dedupe (recipient_user_id, dedupe_key),
  KEY idx_inbox_module_recipient_status (module_id, recipient_user_id, status, created_at),
  KEY idx_inbox_recipient_created (recipient_user_id, created_at),
  CONSTRAINT fk_inbox_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_inbox_user FOREIGN KEY (recipient_user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_module_snapshot (
  snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  record_date DATE NOT NULL,
  required_member_count TINYINT UNSIGNED NOT NULL,
  completed_member_count TINYINT UNSIGNED NOT NULL,
  is_all_completed TINYINT(1) NOT NULL,
  calculation_version INT UNSIGNED NOT NULL DEFAULT 1,
  calculated_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (snapshot_id),
  UNIQUE KEY uq_snapshot_module_date (module_id, record_date),
  KEY idx_snapshot_date_completed (record_date, is_all_completed),
  CONSTRAINT fk_snapshot_module FOREIGN KEY (module_id) REFERENCES life_module(module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_module_snapshot_member (
  snapshot_member_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  snapshot_id BIGINT UNSIGNED NOT NULL,
  member_instance_id BIGINT UNSIGNED NOT NULL,
  join_sequence_snapshot INT UNSIGNED NOT NULL,
  has_effective_record TINYINT(1) NOT NULL,
  record_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (snapshot_member_id),
  UNIQUE KEY uq_snapshot_member (snapshot_id, member_instance_id),
  CONSTRAINT fk_snapshot_member_snapshot FOREIGN KEY (snapshot_id) REFERENCES daily_module_snapshot(snapshot_id),
  CONSTRAINT fk_snapshot_member_member FOREIGN KEY (member_instance_id) REFERENCES module_member(member_instance_id),
  CONSTRAINT fk_snapshot_member_record FOREIGN KEY (record_id) REFERENCES life_record(record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monthly_memory_card (
  memory_card_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  month_key CHAR(7) NOT NULL,
  random_seed VARCHAR(64) NOT NULL,
  generation_version INT UNSIGNED NOT NULL DEFAULT 1,
  data_version VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  generated_image_file_key VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (memory_card_id),
  UNIQUE KEY uq_memory_card (module_id, user_id, month_key),
  KEY idx_memory_user_month (user_id, month_key),
  CONSTRAINT fk_memory_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_memory_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monthly_memory_card_item (
  item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  memory_card_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  member_instance_id BIGINT UNSIGNED NOT NULL,
  display_order TINYINT UNSIGNED NOT NULL,
  is_anonymous TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (item_id),
  UNIQUE KEY uq_memory_item_order (memory_card_id, display_order),
  UNIQUE KEY uq_memory_item_record (memory_card_id, record_id),
  CONSTRAINT fk_memory_item_card FOREIGN KEY (memory_card_id) REFERENCES monthly_memory_card(memory_card_id),
  CONSTRAINT fk_memory_item_record FOREIGN KEY (record_id) REFERENCES life_record(record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reminder_subscription (
  reminder_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  member_instance_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  reminder_time TIME NOT NULL DEFAULT '21:00:00',
  subscription_status VARCHAR(24) NOT NULL DEFAULT 'not_requested',
  last_sent_date DATE NULL,
  last_send_status VARCHAR(24) NULL,
  last_failure_reason VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (reminder_id),
  UNIQUE KEY uq_reminder_member (module_id, member_instance_id),
  KEY idx_reminder_due (enabled, reminder_time),
  KEY idx_reminder_user_date (user_id, last_sent_date),
  CONSTRAINT fk_reminder_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_reminder_member FOREIGN KEY (member_instance_id) REFERENCES module_member(member_instance_id),
  CONSTRAINT fk_reminder_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS idempotency_request (
  idempotency_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  client_request_id VARCHAR(64) NOT NULL,
  request_type VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  resource_type VARCHAR(32) NULL,
  resource_id BIGINT UNSIGNED NULL,
  response_code INT NULL,
  response_snapshot JSON NULL,
  expire_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (idempotency_id),
  UNIQUE KEY uq_idempotency_request (user_id, request_type, client_request_id),
  KEY idx_idempotency_expiry (expire_at),
  CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbox_event (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  aggregate_type VARCHAR(32) NOT NULL,
  aggregate_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  retry_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  PRIMARY KEY (event_id),
  KEY idx_outbox_pending (status, next_retry_at, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NULL,
  operator_user_id BIGINT UNSIGNED NOT NULL,
  operator_member_instance_id BIGINT UNSIGNED NULL,
  action_type VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id BIGINT UNSIGNED NULL,
  result VARCHAR(24) NOT NULL,
  reason_code VARCHAR(64) NULL,
  detail JSON NULL,
  ip_hash CHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (log_id),
  KEY idx_audit_module_created (module_id, created_at),
  KEY idx_audit_operator_created (operator_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS privacy_consent (
  consent_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  privacy_version VARCHAR(32) NOT NULL,
  agreed_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  source VARCHAR(24) NOT NULL DEFAULT 'miniprogram',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consent_id),
  UNIQUE KEY uq_privacy_user_version (user_id, privacy_version),
  CONSTRAINT fk_privacy_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_deletion_request (
  deletion_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  execute_after DATETIME(3) NOT NULL,
  cancelled_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (deletion_request_id),
  KEY idx_deletion_user_status (user_id, status),
  KEY idx_deletion_due (status, execute_after),
  CONSTRAINT fk_deletion_user FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_deletion_status CHECK (status IN ('cooling_off', 'cancelled', 'processing', 'completed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scheduled_job_run (
  job_run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_name VARCHAR(64) NOT NULL,
  run_key VARCHAR(128) NOT NULL,
  status VARCHAR(20) NOT NULL,
  locked_by VARCHAR(128) NULL,
  lock_expires_at DATETIME(3) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (job_run_id),
  UNIQUE KEY uq_job_run_key (job_name, run_key),
  KEY idx_job_due (status, lock_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
