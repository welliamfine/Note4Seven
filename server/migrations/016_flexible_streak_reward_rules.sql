SET @reward_rule_index_exists = (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'streak_reward_rule'
     AND index_name = 'uq_reward_rule_active_sponsor'
);
SET @drop_reward_rule_index = IF(
  @reward_rule_index_exists > 0,
  'ALTER TABLE streak_reward_rule DROP INDEX uq_reward_rule_active_sponsor',
  'SELECT 1'
);
PREPARE drop_reward_rule_index_statement FROM @drop_reward_rule_index;
EXECUTE drop_reward_rule_index_statement;
DEALLOCATE PREPARE drop_reward_rule_index_statement;

SET @reward_rule_column_exists = (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'streak_reward_rule'
     AND column_name = 'active_sponsor_key'
);
SET @drop_reward_rule_column = IF(
  @reward_rule_column_exists > 0,
  'ALTER TABLE streak_reward_rule DROP COLUMN active_sponsor_key',
  'SELECT 1'
);
PREPARE drop_reward_rule_column_statement FROM @drop_reward_rule_column;
EXECUTE drop_reward_rule_column_statement;
DEALLOCATE PREPARE drop_reward_rule_column_statement;

-- MySQL 5.7 parses but does not enforce CHECK constraints. The API validates
-- streak_days as an integer from 1 through 100 before writing the rule.
