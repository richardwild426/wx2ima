import type { Env, Job } from "./types";

export const PDF_RETENTION_DAYS = 365;
export const CLEANUP_BATCH_SIZE = 20;

export function pdfExpiresAt(job: Job): string | null {
  if (
    !job.completed_at ||
    !job.media_id ||
    !["complete", "duplicate"].includes(job.stage)
  )
    return null;
  const completed = Date.parse(`${job.completed_at.replace(" ", "T")}Z`);
  return Number.isFinite(completed)
    ? new Date(completed + PDF_RETENTION_DAYS * 86_400_000).toISOString()
    : null;
}

/** R2 age rules cannot distinguish confirmed IMA entries from retryable imports. */
export async function cleanupExpiredPdfs(env: Env, now = new Date()) {
  const cutoff = new Date(now.getTime() - PDF_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const deletedAt = now.toISOString().slice(0, 19).replace("T", " ");
  const { results } = await env.DB.prepare(
    "SELECT id,object_key FROM jobs WHERE stage IN ('complete','duplicate') AND media_id IS NOT NULL AND completed_at<=? AND pdf_deleted_at IS NULL AND object_key IS NOT NULL ORDER BY completed_at,id LIMIT ?",
  )
    .bind(cutoff, CLEANUP_BATCH_SIZE)
    .all<Pick<Job, "id" | "object_key">>();
  let deleted = 0;
  let failed = 0;
  for (const job of results) {
    try {
      // Terminal job archives are immutable. Delete first: if D1 fails, repeating the
      // idempotent R2 deletion reconciles the record without hiding an undeleted object.
      await env.PDFS.delete(job.object_key as string);
      await env.DB.prepare(
        "UPDATE jobs SET pdf_deleted_at=? WHERE id=? AND object_key=? AND pdf_deleted_at IS NULL",
      )
        .bind(deletedAt, job.id, job.object_key)
        .run();
      deleted++;
    } catch {
      failed++;
    }
  }
  // Do not include object names, account details, provider responses, or credentials in logs.
  if (failed)
    throw new Error(
      `PDF retention cleanup failed for ${failed} archive(s); ${deleted} cleaned.`,
    );
  return { deleted };
}
