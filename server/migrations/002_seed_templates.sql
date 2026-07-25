INSERT INTO module_template (template_code, display_name, name, description, sort_order, status)
VALUES
  ('drink', '摄入饮品中...', '今天喝了什么', '记录每天的续命饮料，攒够一辈子的快乐水', 1, 'active'),
  ('meal', '好好吃饭中...', '今天吃了什么', '把认真吃饭的每一天都留下来', 2, 'active'),
  ('exercise', '正在动起来...', '今天运动了吗', '记录每一次让身体舒展开来的时刻', 3, 'active'),
  ('moment', '收集小事中...', '今天的小事', '把普通日子里的小事慢慢存起来', 4, 'active')
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  name = VALUES(name),
  description = VALUES(description),
  sort_order = VALUES(sort_order),
  status = VALUES(status);
