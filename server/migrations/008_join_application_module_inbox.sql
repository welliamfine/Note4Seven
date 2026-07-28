UPDATE notification n
JOIN join_application ja ON ja.application_id = n.target_id AND n.target_type = 'join_application'
JOIN life_module m ON m.module_id = ja.module_id
SET n.user_id = m.creator_user_id,
    n.updated_at = UTC_TIMESTAMP(3)
WHERE ja.status = 'pending';

INSERT IGNORE INTO module_inbox_item
  (module_id, recipient_user_id, type, title, content, target_type, target_id,
   status, dedupe_key, created_at, updated_at, expire_at)
SELECT ja.module_id,
       m.creator_user_id,
       'join_application',
       '新的加入申请',
       CONCAT('「', ja.applicant_name_snapshot, '」申请加入 ', m.name),
       'join_application',
       ja.application_id,
       CASE WHEN n.is_read = 1 THEN 'read' ELSE 'unread' END,
       CONCAT('join_application:', ja.application_id),
       ja.created_at,
       UTC_TIMESTAMP(3),
       ja.expire_at
FROM join_application ja
JOIN life_module m ON m.module_id = ja.module_id
LEFT JOIN notification n ON n.target_type = 'join_application' AND n.target_id = ja.application_id
  AND n.user_id = m.creator_user_id
WHERE ja.status = 'pending';
