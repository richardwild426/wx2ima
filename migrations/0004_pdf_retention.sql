ALTER TABLE jobs ADD COLUMN completed_at TEXT;
ALTER TABLE jobs ADD COLUMN pdf_deleted_at TEXT;

-- Legacy terminal jobs were updated when IMA verification completed.
UPDATE jobs SET completed_at=updated_at
WHERE stage IN ('complete','duplicate') AND media_id IS NOT NULL;

CREATE INDEX jobs_pdf_retention ON jobs(completed_at)
WHERE stage IN ('complete','duplicate') AND pdf_deleted_at IS NULL AND object_key IS NOT NULL AND media_id IS NOT NULL;
