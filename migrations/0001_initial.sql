CREATE TABLE profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_name TEXT NOT NULL,
 client_fingerprint TEXT NOT NULL UNIQUE, credentials TEXT NOT NULL,
 inbox_id TEXT, inbox_name TEXT, kb_count INTEGER NOT NULL DEFAULT 0,
 verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE mappings (
 profile_id TEXT NOT NULL REFERENCES profiles(id), account_key TEXT NOT NULL, account_name TEXT NOT NULL,
 kb_id TEXT NOT NULL, kb_name TEXT NOT NULL, PRIMARY KEY(profile_id,account_key)
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), source_url TEXT NOT NULL, url_hash TEXT NOT NULL,
 article_key TEXT, account_key TEXT, account_name TEXT, title TEXT, file_name TEXT, object_key TEXT,
 file_size INTEGER, file_hash TEXT, page_count INTEGER, kb_id TEXT, kb_name TEXT, used_inbox INTEGER NOT NULL DEFAULT 0,
 media_id TEXT, cos_key TEXT, stage TEXT NOT NULL DEFAULT 'queued', error TEXT, workflow_id TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX jobs_profile_date ON jobs(profile_id,created_at DESC);
CREATE UNIQUE INDEX jobs_active_url ON jobs(profile_id,url_hash) WHERE stage NOT IN ('complete','duplicate','failed');
CREATE TABLE imports (
 profile_id TEXT NOT NULL, article_key TEXT NOT NULL, kb_id TEXT NOT NULL,
 job_id TEXT NOT NULL, media_id TEXT, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(profile_id,article_key,kb_id)
);
