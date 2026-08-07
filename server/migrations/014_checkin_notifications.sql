ALTER TABLE reminder_subscription
  ADD COLUMN checkin_notify_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER subscription_status,
  ADD COLUMN checkin_notify_status VARCHAR(24) NOT NULL DEFAULT 'not_requested' AFTER checkin_notify_enabled,
  ADD COLUMN checkin_notify_credits TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER checkin_notify_status,
  ADD COLUMN checkin_notify_last_sent_at DATETIME(3) NULL AFTER checkin_notify_credits,
  ADD COLUMN checkin_notify_last_send_status VARCHAR(24) NULL AFTER checkin_notify_last_sent_at,
  ADD COLUMN checkin_notify_last_failure_reason VARCHAR(64) NULL AFTER checkin_notify_last_send_status,
  ADD KEY idx_checkin_notify_ready (module_id, checkin_notify_enabled, checkin_notify_credits);
