UPDATE module_template
SET name = CASE template_code
  WHEN 'drink' THEN '饮品check！'
  WHEN 'meal' THEN '美食check！'
  WHEN 'exercise' THEN '健身check！'
  WHEN 'moment' THEN '自律check！'
  ELSE name
END
WHERE template_code IN ('drink', 'meal', 'exercise', 'moment');
