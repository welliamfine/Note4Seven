CREATE TABLE IF NOT EXISTS discovery_post (
  post_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  author_user_id BIGINT UNSIGNED NOT NULL,
  author_name_snapshot VARCHAR(64) NOT NULL,
  author_avatar_file_key_snapshot VARCHAR(512) NULL,
  post_type VARCHAR(32) NOT NULL,
  public_text VARCHAR(500) NULL,
  source_type VARCHAR(32) NOT NULL,
  source_reference VARCHAR(160) NOT NULL,
  snapshot_payload JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'reviewing',
  like_count INT UNSIGNED NOT NULL DEFAULT 0,
  comment_count INT UNSIGNED NOT NULL DEFAULT 0,
  reviewed_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  active_source_key VARCHAR(255) GENERATED ALWAYS AS (
    IF(status IN ('reviewing', 'published'), CONCAT(author_user_id, ':', source_reference), NULL)
  ) STORED,
  PRIMARY KEY (post_id),
  UNIQUE KEY uq_discovery_post_active_source (active_source_key),
  KEY idx_discovery_post_feed (status, published_at, post_id),
  KEY idx_discovery_post_author (author_user_id, status, created_at),
  CONSTRAINT fk_discovery_post_author FOREIGN KEY (author_user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_discovery_post_type CHECK (
    post_type IN ('record', 'calendar', 'board', 'easter_egg', 'module_recruitment')
  ),
  CONSTRAINT chk_discovery_post_status CHECK (
    status IN ('reviewing', 'published', 'rejected', 'deleted')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_recruitment (
  recruitment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_id BIGINT UNSIGNED NOT NULL,
  post_id BIGINT UNSIGNED NOT NULL,
  creator_user_id BIGINT UNSIGNED NOT NULL,
  invite_token_id BIGINT UNSIGNED NOT NULL,
  public_description VARCHAR(300) NOT NULL,
  member_count_at_publish TINYINT UNSIGNED NOT NULL,
  member_limit TINYINT UNSIGNED NOT NULL DEFAULT 4,
  recruitment_slots TINYINT UNSIGNED NOT NULL,
  expire_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'recruiting',
  closed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version INT UNSIGNED NOT NULL DEFAULT 0,
  active_module_key BIGINT UNSIGNED GENERATED ALWAYS AS (
    IF(status = 'recruiting', module_id, NULL)
  ) STORED,
  PRIMARY KEY (recruitment_id),
  UNIQUE KEY uq_discovery_recruitment_post (post_id),
  UNIQUE KEY uq_discovery_recruitment_active_module (active_module_key),
  KEY idx_discovery_recruitment_status_expire (status, expire_at),
  CONSTRAINT fk_discovery_recruitment_module FOREIGN KEY (module_id) REFERENCES life_module(module_id),
  CONSTRAINT fk_discovery_recruitment_post FOREIGN KEY (post_id) REFERENCES discovery_post(post_id),
  CONSTRAINT fk_discovery_recruitment_creator FOREIGN KEY (creator_user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_discovery_recruitment_invite FOREIGN KEY (invite_token_id) REFERENCES invite_token(invite_token_id),
  CONSTRAINT chk_discovery_recruitment_status CHECK (
    status IN ('recruiting', 'full', 'expired', 'closed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_post_like (
  post_like_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (post_like_id),
  UNIQUE KEY uq_discovery_post_like (post_id, user_id),
  KEY idx_discovery_post_like_user (user_id, created_at),
  CONSTRAINT fk_discovery_post_like_post FOREIGN KEY (post_id) REFERENCES discovery_post(post_id),
  CONSTRAINT fk_discovery_post_like_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_comment (
  comment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  parent_comment_id BIGINT UNSIGNED NULL,
  reply_to_user_id BIGINT UNSIGNED NULL,
  author_name_snapshot VARCHAR(64) NOT NULL,
  author_avatar_file_key_snapshot VARCHAR(512) NULL,
  content VARCHAR(500) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (comment_id),
  KEY idx_discovery_comment_post (post_id, status, created_at, comment_id),
  KEY idx_discovery_comment_user (user_id, status, created_at),
  CONSTRAINT fk_discovery_comment_post FOREIGN KEY (post_id) REFERENCES discovery_post(post_id),
  CONSTRAINT fk_discovery_comment_user FOREIGN KEY (user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_discovery_comment_parent FOREIGN KEY (parent_comment_id) REFERENCES discovery_comment(comment_id),
  CONSTRAINT fk_discovery_comment_reply_user FOREIGN KEY (reply_to_user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_discovery_comment_status CHECK (status IN ('active', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_user_block (
  block_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blocker_user_id BIGINT UNSIGNED NOT NULL,
  blocked_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (block_id),
  UNIQUE KEY uq_discovery_user_block (blocker_user_id, blocked_user_id),
  KEY idx_discovery_user_blocked (blocked_user_id, blocker_user_id),
  CONSTRAINT fk_discovery_user_blocker FOREIGN KEY (blocker_user_id) REFERENCES user_account(user_id),
  CONSTRAINT fk_discovery_user_blocked FOREIGN KEY (blocked_user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_report (
  report_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_user_id BIGINT UNSIGNED NOT NULL,
  target_type VARCHAR(16) NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(32) NOT NULL,
  detail VARCHAR(300) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_discovery_report_target (reporter_user_id, target_type, target_id),
  KEY idx_discovery_report_queue (status, created_at),
  CONSTRAINT fk_discovery_report_user FOREIGN KEY (reporter_user_id) REFERENCES user_account(user_id),
  CONSTRAINT chk_discovery_report_target CHECK (target_type IN ('post', 'comment')),
  CONSTRAINT chk_discovery_report_status CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discovery_post_dismissal (
  dismissal_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (dismissal_id),
  UNIQUE KEY uq_discovery_post_dismissal (post_id, user_id),
  CONSTRAINT fk_discovery_post_dismissal_post FOREIGN KEY (post_id) REFERENCES discovery_post(post_id),
  CONSTRAINT fk_discovery_post_dismissal_user FOREIGN KEY (user_id) REFERENCES user_account(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE join_application
  ADD COLUMN application_source VARCHAR(24) NOT NULL DEFAULT 'invite' AFTER invite_token_id;

ALTER TABLE streak_reward_draw
  ADD COLUMN redeemed_at DATETIME(3) NULL AFTER revealed_at;
