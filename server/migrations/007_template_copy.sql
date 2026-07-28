UPDATE module_template
SET
  name = CASE template_code
    WHEN 'drink' THEN '饮品check！'
    WHEN 'meal' THEN '美食check！'
    WHEN 'exercise' THEN '健身check！'
    WHEN 'moment' THEN '自律check！'
    ELSE name
  END,
  description = CASE template_code
    WHEN 'drink' THEN '今天喝啥了？'
    WHEN 'meal' THEN '今天吃啥了？'
    WHEN 'exercise' THEN '肌肉生长中'
    WHEN 'moment' THEN '所有目标完成完成完成！'
    ELSE description
  END
WHERE template_code IN ('drink', 'meal', 'exercise', 'moment');
