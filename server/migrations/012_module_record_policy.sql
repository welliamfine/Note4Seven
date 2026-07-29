ALTER TABLE life_module
  ADD COLUMN record_policy VARCHAR(16) NOT NULL DEFAULT 'strict' AFTER mode;

