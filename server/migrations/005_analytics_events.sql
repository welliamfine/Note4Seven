CREATE TABLE IF NOT EXISTS analytics_event (
  analytics_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_event_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  release_id VARCHAR(128) NOT NULL,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  device_type VARCHAR(24) NOT NULL,
  network_type VARCHAR(24) NOT NULL,
  properties JSON NOT NULL,
  PRIMARY KEY (analytics_event_id),
  UNIQUE KEY uk_analytics_client_event (client_event_id),
  KEY idx_analytics_event_time (event_name, occurred_at),
  KEY idx_analytics_user_time (user_hash, occurred_at),
  KEY idx_analytics_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
