UPDATE module_inbox_item i
JOIN join_application ja
  ON i.target_type = 'join_application' AND i.target_id = ja.application_id
SET i.status = 'unread', i.updated_at = UTC_TIMESTAMP(3)
WHERE ja.status = 'pending' AND i.status = 'read';

UPDATE module_inbox_item i
JOIN makeup_approval ma
  ON i.target_type = 'makeup_approval' AND i.target_id = ma.approval_id
SET i.status = 'unread', i.updated_at = UTC_TIMESTAMP(3)
WHERE ma.status = 'pending' AND i.status = 'read';

UPDATE module_inbox_item i
JOIN makeup_approval ma
  ON i.target_type = 'makeup_approval' AND i.target_id = ma.approval_id
LEFT JOIN module_member resolver
  ON resolver.member_instance_id = ma.resolved_by_member_instance_id
SET i.type = 'makeup_result',
    i.title = '补卡已处理',
    i.content = CONCAT('「', COALESCE(resolver.nickname_snapshot, '其他成员'), '」已',
      IF(ma.status = 'approved', '通过', '拒绝'), '该补卡申请'),
    i.status = IF(i.recipient_user_id = ma.resolved_by_user_id, 'read', 'unread'),
    i.updated_at = UTC_TIMESTAMP(3),
    i.expire_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
WHERE ma.status IN ('approved', 'rejected') AND i.status = 'resolved';

INSERT IGNORE INTO module_inbox_item
  (module_id, recipient_user_id, type, title, content, target_type, target_id, record_date,
   status, dedupe_key, created_at, updated_at, expire_at)
SELECT ma.module_id, ma.applicant_user_id, 'makeup_result',
       IF(ma.status = 'approved', '补卡已通过', '补卡未通过'),
       IF(ma.status = 'approved', '你的补卡记录已经生效', '本次补卡申请被拒绝'),
       'record', ma.record_id, ma.target_date, IF(n.is_read = 1, 'read', 'unread'),
       CONCAT('makeup_result:', ma.approval_id, ':', ma.applicant_user_id),
       COALESCE(ma.resolved_at, ma.updated_at), UTC_TIMESTAMP(3),
       DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
FROM makeup_approval ma
LEFT JOIN notification n
  ON n.user_id = ma.applicant_user_id AND n.type = 'makeup_result'
  AND n.target_type = 'record' AND n.target_id = ma.record_id
WHERE ma.status IN ('approved', 'rejected');
