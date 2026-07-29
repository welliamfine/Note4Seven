INSERT IGNORE INTO notification
  (user_id, type, title, content, module_id, target_type, target_id, record_date,
   action_type, action_status, is_read, read_at, expired_at, dedupe_key, created_at, updated_at)
SELECT i.recipient_user_id,
       IF(ma.status = 'pending', 'makeup_approval', 'makeup_result'),
       i.title, i.content, i.module_id, 'makeup_approval', ma.approval_id, ma.target_date,
       IF(ma.status = 'pending', 'approve_makeup', 'none'),
       IF(ma.status = 'pending', 'actionable', 'none'),
       IF(ma.status = 'pending', 0, i.status = 'read'),
       IF(ma.status <> 'pending' AND i.status = 'read', COALESCE(ma.resolved_at, ma.updated_at), NULL),
       ma.expire_at,
       CONCAT('makeup_application:', ma.approval_id, ':', i.recipient_user_id),
       i.created_at, UTC_TIMESTAMP(3)
  FROM module_inbox_item i
  JOIN makeup_approval ma
    ON i.target_type = 'makeup_approval' AND i.target_id = ma.approval_id
 WHERE ma.status IN ('pending', 'approved', 'rejected');

UPDATE notification n
JOIN makeup_approval ma
  ON n.target_type = 'makeup_approval' AND n.target_id = ma.approval_id
LEFT JOIN module_inbox_item i
  ON i.target_type = 'makeup_approval' AND i.target_id = ma.approval_id
 AND i.recipient_user_id = n.user_id
SET n.type = IF(ma.status = 'pending', 'makeup_approval', 'makeup_result'),
    n.title = COALESCE(i.title, n.title),
    n.content = COALESCE(i.content, n.content),
    n.action_type = IF(ma.status = 'pending', 'approve_makeup', 'none'),
    n.action_status = IF(ma.status = 'pending', 'actionable', 'none'),
    n.is_read = IF(ma.status = 'pending', 0, COALESCE(i.status = 'read', n.is_read)),
    n.read_at = IF(ma.status = 'pending', NULL,
      IF(COALESCE(i.status = 'read', n.is_read), COALESCE(n.read_at, ma.resolved_at, UTC_TIMESTAMP(3)), NULL)),
    n.updated_at = UTC_TIMESTAMP(3)
WHERE ma.status IN ('pending', 'approved', 'rejected');

UPDATE notification n
JOIN join_application ja
  ON n.target_type = 'join_application' AND n.target_id = ja.application_id
SET n.type = 'join_result',
    n.action_type = 'none',
    n.action_status = 'none',
    n.updated_at = UTC_TIMESTAMP(3)
WHERE ja.status IN ('approved', 'rejected', 'expired', 'cancelled')
  AND n.action_status IN ('actionable', 'processing', 'resolved', 'expired');
