CREATE TABLE import_queue_control (
 id INTEGER PRIMARY KEY CHECK (id=1),
 cooldown_until TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'
);
INSERT INTO import_queue_control(id) VALUES (1);
CREATE INDEX jobs_queue_pending ON jobs(created_at) WHERE stage='queued' AND workflow_id IS NULL;
CREATE INDEX jobs_queue_active ON jobs(updated_at) WHERE stage NOT IN ('complete','duplicate','failed') AND (workflow_id IS NOT NULL OR stage<>'queued');
