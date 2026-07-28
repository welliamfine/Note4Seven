INSERT IGNORE INTO module_inbox_item
  (module_id, recipient_user_id, type, title, content, target_type, target_id,
   status, dedupe_key, created_at, updated_at, expire_at)
SELECT departed.module_id,
       active_member.user_id,
       'member_change',
       '成员退出',
       CONCAT('「', departed.nickname_snapshot, '」已退出「', m.name, '」'),
       'member',
       departed.member_instance_id,
       'unread',
       CONCAT(IF(departed.leave_reason = 'removed', 'member_removed:', 'member_exit:'), departed.member_instance_id),
       COALESCE(departed.left_at, departed.updated_at),
       UTC_TIMESTAMP(3),
       DATE_ADD(COALESCE(departed.left_at, departed.updated_at), INTERVAL 30 DAY)
FROM module_member departed
JOIN life_module m ON m.module_id = departed.module_id
JOIN module_member active_member
  ON active_member.module_id = departed.module_id AND active_member.status = 'active'
WHERE departed.status IN ('exited', 'removed')
  AND COALESCE(departed.left_at, departed.updated_at) > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY);

INSERT IGNORE INTO notification
  (user_id, type, title, content, module_id, target_type, target_id,
   action_type, action_status, is_read, dedupe_key, created_at, updated_at)
SELECT active_member.user_id,
       'member_change',
       '成员退出',
       CONCAT('「', departed.nickname_snapshot, '」已退出「', m.name, '」'),
       departed.module_id,
       'member',
       departed.member_instance_id,
       'none',
       'none',
       0,
       CONCAT(IF(departed.leave_reason = 'removed', 'member_removed:', 'member_exit:'), departed.member_instance_id),
       COALESCE(departed.left_at, departed.updated_at),
       UTC_TIMESTAMP(3)
FROM module_member departed
JOIN life_module m ON m.module_id = departed.module_id
JOIN module_member active_member
  ON active_member.module_id = departed.module_id AND active_member.status = 'active'
WHERE departed.status IN ('exited', 'removed')
  AND COALESCE(departed.left_at, departed.updated_at) > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY);
