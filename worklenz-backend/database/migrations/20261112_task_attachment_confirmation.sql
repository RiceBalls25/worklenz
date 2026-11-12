-- Run once BEFORE deploying backend code that uses upload_confirmed_at.
-- This migration is safe to rerun: it backfills legacy rows ONLY when the column is first created.
-- Historic records are kept visible for compatibility; pre-existing NoSuchKey rows require separate audit.
-- IMPORTANT: do not remove this guard; rerunning a plain UPDATE would incorrectly confirm pending uploads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'task_attachments'::regclass
      AND attname = 'upload_confirmed_at'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE task_attachments
      ADD COLUMN upload_confirmed_at TIMESTAMPTZ;
    UPDATE task_attachments
      SET upload_confirmed_at = COALESCE(created_at, NOW());
  END IF;
END;
$$;
