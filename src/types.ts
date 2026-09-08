export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PDFS: R2Bucket;
  IMPORTS: Workflow<{ jobId: string }>;
  ENCRYPTION_KEY: string;
  ACCESS_PASSWORD_HASH: string;
  APP_ORIGIN: string;
}
export interface Credentials {
  clientId: string;
  apiKey: string;
}
export interface Profile {
  id: string;
  name: string;
  owner_name: string;
  client_fingerprint: string;
  credentials: string;
  inbox_id: string | null;
  inbox_name: string | null;
  kb_count: number;
  verified_at: string;
  deleted_at: string | null;
}
export interface Mapping {
  account_key: string;
  account_name: string;
  kb_id: string;
  kb_name: string;
}
export interface Job {
  id: string;
  profile_id: string;
  source_url: string;
  url_hash: string;
  article_key: string | null;
  account_key: string | null;
  account_name: string | null;
  title: string | null;
  file_name: string | null;
  object_key: string | null;
  file_size: number | null;
  file_hash: string | null;
  page_count: number | null;
  kb_id: string | null;
  kb_name: string | null;
  used_inbox: number;
  media_id: string | null;
  cos_key: string | null;
  stage: string;
  add_state: string | null;
  error: string | null;
  workflow_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  pdf_deleted_at: string | null;
}
export interface KnowledgeBase {
  id: string;
  name: string;
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}
