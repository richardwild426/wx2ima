import { pdfExpiresAt } from "./retention";
import { AppError, type Env, type Job, type Profile } from "./types";
export async function profile(env: Env, id: string) {
  const p = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?")
    .bind(id)
    .first<Profile>();
  if (!p) throw new AppError("未找到 IMA 账号。", 404);
  return p;
}
export function requireActiveProfile(p: Profile) {
  if (p.deleted_at)
    throw new AppError("此账号已删除，仅可查看历史记录和下载 PDF。", 409);
  return p;
}
export async function jobById(env: Env, id: string) {
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id)
    .first<Job>();
  if (!j) throw new AppError("未找到导入任务。", 404);
  return j;
}
const fields = new Set([
  "article_key",
  "account_key",
  "account_name",
  "title",
  "file_name",
  "object_key",
  "file_size",
  "file_hash",
  "page_count",
  "kb_id",
  "kb_name",
  "used_inbox",
  "media_id",
  "cos_key",
  "stage",
  "add_state",
  "error",
  "workflow_id",
  "attempts",
  "completed_at",
  "published_date",
  "publication_date_checked_at",
]);
export async function updateJob(env: Env, id: string, values: Partial<Job>) {
  const entries = Object.entries(values).filter(([k]) => fields.has(k));
  if (!entries.length) return;
  await env.DB.prepare(
    `UPDATE jobs SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at=datetime('now') WHERE id=?`,
  )
    .bind(...entries.map(([, v]) => v ?? null), id)
    .run();
}
export function publicProfile(p: Profile) {
  const { id, name, owner_name, inbox_id, inbox_name, kb_count, verified_at } =
    p;
  return {
    id,
    name,
    owner_name,
    inbox_id,
    inbox_name,
    kb_count,
    verified_at,
    deleted_at: p.deleted_at ?? null,
    fingerprint: p.client_fingerprint.slice(0, 12),
    identity_source: "user-provided",
  };
}
export function publicJob(j: Job) {
  const {
    id,
    profile_id,
    title,
    account_name,
    file_name,
    file_size,
    page_count,
    kb_name,
    used_inbox,
    stage,
    error,
    created_at,
    updated_at,
    source_url,
    account_key,
  } = j;
  return {
    id,
    profile_id,
    title,
    account_name,
    file_name,
    file_size,
    page_count,
    kb_name,
    used_inbox: !!used_inbox,
    stage,
    error,
    created_at,
    updated_at,
    source_url,
    account_key,
    has_pdf: !!j.object_key && !j.pdf_deleted_at,
    pdf_deleted_at: j.pdf_deleted_at ?? null,
    pdf_expires_at: pdfExpiresAt(j),
    published_date: j.published_date ?? null,
  };
}
