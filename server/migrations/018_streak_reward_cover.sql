ALTER TABLE streak_reward_rule
  ADD COLUMN cover_media_id BIGINT UNSIGNED NULL AFTER target_member_instance_id,
  ADD KEY idx_reward_rule_cover_media (cover_media_id),
  ADD CONSTRAINT fk_reward_rule_cover_media FOREIGN KEY (cover_media_id) REFERENCES media_asset(media_id) ON DELETE SET NULL;

ALTER TABLE streak_reward_event
  ADD COLUMN cover_media_id_snapshot BIGINT UNSIGNED NULL AFTER target_type,
  ADD KEY idx_reward_event_cover_media (cover_media_id_snapshot),
  ADD CONSTRAINT fk_reward_event_cover_media FOREIGN KEY (cover_media_id_snapshot) REFERENCES media_asset(media_id) ON DELETE SET NULL;
