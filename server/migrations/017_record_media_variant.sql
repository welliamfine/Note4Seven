ALTER TABLE life_record
  ADD COLUMN media_variant VARCHAR(16) NOT NULL DEFAULT 'sticker' AFTER media_id;

ALTER TABLE record_revision
  ADD COLUMN media_variant VARCHAR(16) NOT NULL DEFAULT 'sticker' AFTER media_id;

