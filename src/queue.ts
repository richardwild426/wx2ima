import { digest } from "./security";
import { profile, requireActiveProfile } from "./store";
import { AppError, type Env, type Job } from "./types";

/** Persist the whole transport chunk atomically; no third-party work runs in this request. */
export async function enqueueArticles(
  env: Env,
  profileId: string,
  urls: string[],
) {
  const input = await Promise.all(
    urls.map(async (url) => ({
      id: crypto.randomUUID(),
      url,
      hash: await digest(url),
    })),
  );
  const payload = JSON.stringify(input);
  // RETURNING acknowledges the same atomic write, even if a previously queued job
  // completes immediately afterward. The no-op conflict update preserves its progress.
  const { results } = await env.DB.prepare(
    "INSERT INTO jobs(id,profile_id,source_url,url_hash) SELECT json_extract(value,'$.id'),profiles.id,json_extract(value,'$.url'),json_extract(value,'$.hash') FROM json_each(?) JOIN profiles ON profiles.id=? AND profiles.deleted_at IS NULL AND profiles.inbox_id IS NOT NULL WHERE true ON CONFLICT(profile_id,url_hash) WHERE stage NOT IN ('complete','duplicate','failed') DO UPDATE SET url_hash=excluded.url_hash RETURNING *",
  )
    .bind(payload, profileId)
    .all<Job>();
  const byHash = new Map(results.map((job) => [job.url_hash, job]));
  if (input.some(({ hash }) => !byHash.has(hash))) {
    requireActiveProfile(await profile(env, profileId));
    throw new AppError("账号配置已变化，请刷新后重试。", 409);
  }
  return input.map(({ hash }) => byHash.get(hash) as Job);
}

/** Atomic conditional UPDATE reserves the sole worker slot across API, cron and workflow invocations. */
export async function dispatchQueue(env: Env) {
  const { results: active } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE stage NOT IN ('complete','duplicate','failed') AND (workflow_id IS NOT NULL OR stage<>'queued') ORDER BY updated_at LIMIT 5",
  ).all<Job>();
  for (const job of active) {
    if (
      !job.workflow_id ||
      Date.now() - Date.parse(`${job.updated_at.replace(" ", "T")}Z`) < 120000
    )
      continue;
    try {
      const instance = await env.IMPORTS.get(job.workflow_id);
      const status = await instance.status();
      if (["errored", "terminated", "complete"].includes(status.status)) {
        // The workflow may have been killed before its D1 failure handler could run.
        await env.DB.prepare(
          "UPDATE jobs SET stage='failed',error=?,updated_at=datetime('now') WHERE id=? AND workflow_id=? AND stage NOT IN ('complete','duplicate','failed')",
        )
          .bind(
            "后台任务已停止，请重试；已保存的 PDF 和上传进度会保留。",
            job.id,
            job.workflow_id,
          )
          .run();
      }
    } catch {
      if (job.stage === "queued") {
        // A create timeout cannot prove the instance is absent. Reuse the reserved ID;
        // createBatch is idempotent even if another dispatcher already created it.
        try {
          await env.IMPORTS.createBatch([
            { id: job.workflow_id, params: { jobId: job.id } },
          ]);
        } catch {
          /* Keep the reservation; a later cron run retries without admitting a second job. */
        }
      }
    }
  }
  const workflowId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "UPDATE jobs SET workflow_id=?,error=NULL,updated_at=datetime('now') WHERE id=(SELECT id FROM jobs WHERE stage='queued' AND workflow_id IS NULL ORDER BY created_at,rowid LIMIT 1) AND NOT EXISTS (SELECT 1 FROM jobs WHERE stage NOT IN ('complete','duplicate','failed') AND (workflow_id IS NOT NULL OR stage<>'queued')) AND EXISTS (SELECT 1 FROM import_queue_control WHERE id=1 AND cooldown_until<=datetime('now')) RETURNING *",
  )
    .bind(workflowId)
    .first<Job>();
  if (!claimed) return;
  try {
    await env.IMPORTS.create({ id: workflowId, params: { jobId: claimed.id } });
  } catch {
    /* The durable reservation is recovered by cron if the create response is lost. */
  }
}

/** Accepted jobs stay accepted even if dispatch is temporarily unavailable. Cron is the durable fallback. */
export async function kickQueue(env: Env) {
  try {
    await dispatchQueue(env);
  } catch {
    console.warn("import_queue_dispatch_unavailable");
  }
}

export async function deferImport(env: Env, jobId: string, until: Date) {
  const date = new Date(Math.ceil(until.getTime() / 1000) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE import_queue_control SET cooldown_until=MAX(cooldown_until,?) WHERE id=1",
    ).bind(date),
    env.DB.prepare(
      "UPDATE jobs SET stage='queued',workflow_id=NULL,error=?,updated_at=datetime('now') WHERE id=? AND stage NOT IN ('complete','duplicate')",
    ).bind("第三方服务限流，已暂停队列，将自动继续。", jobId),
  ]);
}

export async function queueSummary(env: Env, profileId: string) {
  return await env.DB.prepare(
    "SELECT COUNT(CASE WHEN stage='queued' AND workflow_id IS NULL THEN 1 END) AS queued,COUNT(CASE WHEN stage NOT IN ('complete','duplicate','failed') AND (workflow_id IS NOT NULL OR stage<>'queued') THEN 1 END) AS running FROM jobs WHERE profile_id=?",
  )
    .bind(profileId)
    .first<{ queued: number; running: number }>();
}
