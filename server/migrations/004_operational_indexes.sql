ALTER TABLE outbox_event
  ADD KEY idx_outbox_type_pending (event_type, status, next_retry_at, event_id);

ALTER TABLE media_asset
  ADD KEY idx_media_original_key (original_file_key(191)),
  ADD KEY idx_media_content_trace (content_check_trace_id),
  ADD KEY idx_media_module_status_updated (module_id, status, updated_at);
