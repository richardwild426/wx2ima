import { normalizeArticleUrl } from "./article";
import { knowledgeBases, validateBase } from "./ima";
import {
  connectProfile,
  deleteProfile,
  editProfile,
  inputText as text,
} from "./profiles";
import {
  dispatchQueue,
  enqueueArticles,
  kickQueue,
  queueSummary,
} from "./queue";
import { cleanupExpiredPdfs } from "./retention";
import {
  checkOrigin,
  createSession,
  decrypt,
  digest,
  jsonBody,
  publicError,
  rateLimit,
  session,
  verifyPassword,
} from "./security";
import {
  jobById,
  profile,
  publicJob,
  publicProfile,
  requireActiveProfile,
} from "./store";
import {
  AppError,
  type Credentials,
  type Env,
  type Job,
  type Mapping,
  type Profile,
} from "./types";

export { ImportWorkflow } from "./workflow";

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
async function credentials(env: Env, id: string) {
  const p = requireActiveProfile(await profile(env, id));
  return decrypt<Credentials>(p.credentials, env.ENCRYPTION_KEY, p.id);
}
export async function handle(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("不支持此请求方法。", { status: 405 });
    if (
      !["/", "/index.html", "/styles.css", "/app.js", "/favicon.svg"].includes(
        path,
      )
    )
      return new Response("未找到请求的资源。", { status: 404 });
    return env.ASSETS.fetch(request);
  }
  checkOrigin(request, env);
  if (path === "/api/session" && request.method === "GET")
    return json({
      authenticated: !!(await session(request, env)),
      configured: !!env.ACCESS_PASSWORD_HASH,
    });
  if (path === "/api/login" && request.method === "POST") {
    const body = await jsonBody<{ password: unknown }>(request);
    const password = text(body.password, "访问口令", 256);
    await rateLimit(
      env,
      `login:${await digest(request.headers.get("CF-Connecting-IP") ?? "unknown")}`,
      8,
      900,
    );
    await rateLimit(env, "login-global", 100, 60);
    if (!(await verifyPassword(password, env.ACCESS_PASSWORD_HASH)))
      throw new AppError("访问口令错误。", 401);
    return json({ ok: true }, 200, { "Set-Cookie": await createSession(env) });
  }
  const token = await session(request, env);
  if (!token) throw new AppError("请先登录再继续。", 401);
  if (path === "/api/logout" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(token)
      .run();
    return json({ ok: true }, 200, {
      "Set-Cookie":
        "__Host-wx2ima=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    });
  }
  if (path === "/api/profiles" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM profiles WHERE deleted_at IS NULL OR EXISTS (SELECT 1 FROM jobs WHERE profile_id=profiles.id) ORDER BY (deleted_at IS NOT NULL),verified_at DESC",
    ).all<Profile>();
    return json({ profiles: results.map(publicProfile) });
  }
  if (path === "/api/profiles" && request.method === "POST") {
    return json(await connectProfile(env, await jsonBody(request)), 201);
  }
  const profileRoute = path.match(
    /^\/api\/profiles\/([a-f0-9-]+)(?:\/(knowledge-bases|settings|mappings))?$/,
  );
  if (profileRoute) {
    const id = profileRoute[1] as string,
      action = profileRoute[2];
    const p = await profile(env, id);
    if (!action && request.method === "GET")
      return json({ profile: publicProfile(p) });
    requireActiveProfile(p);
    if (!action && request.method === "PUT")
      return json(await editProfile(env, p, await jsonBody(request)));
    if (!action && request.method === "DELETE") {
      await jsonBody(request);
      return json(await deleteProfile(env, p));
    }
    if (action === "knowledge-bases" && request.method === "GET")
      return json({
        knowledgeBases: await knowledgeBases(await credentials(env, id)),
      });
    if (action === "settings" && request.method === "PUT") {
      const body = await jsonBody<{ inboxId: unknown }>(request);
      const kb = await validateBase(
        await credentials(env, id),
        text(body.inboxId, "待分类知识库"),
      );
      const updated = await env.DB.prepare(
        "UPDATE profiles SET inbox_id=?,inbox_name=? WHERE id=? AND deleted_at IS NULL AND credentials=?",
      )
        .bind(kb.id, kb.name, id, p.credentials)
        .run();
      if (!updated.meta.changes)
        throw new AppError("账号配置已变化，请刷新后重试。", 409);
      return json({ profile: publicProfile(await profile(env, id)) });
    }
    if (action === "mappings" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM mappings WHERE profile_id=? ORDER BY account_name",
      )
        .bind(id)
        .all<Mapping>();
      return json({ mappings: results });
    }
    if (action === "mappings" && request.method === "POST") {
      const body = await jsonBody<{
        accountKey?: unknown;
        accountName: unknown;
        kbId: unknown;
      }>(request);
      const name = text(body.accountName, "公众号名称");
      const accountKey = body.accountKey
        ? text(body.accountKey, "公众号标识", 512)
        : `name:${name.normalize("NFKC")}`;
      if (!accountKey.startsWith("name:") && !accountKey.startsWith("biz:"))
        throw new AppError("公众号标识无效。");
      const kb = await validateBase(
        await credentials(env, id),
        text(body.kbId, "公众号分配的目标知识库"),
      );
      const updated = await env.DB.prepare(
        "INSERT INTO mappings(profile_id,account_key,account_name,kb_id,kb_name) SELECT id,?,?,?,? FROM profiles WHERE id=? AND deleted_at IS NULL AND credentials=? ON CONFLICT(profile_id,account_key) DO UPDATE SET account_name=excluded.account_name,kb_id=excluded.kb_id,kb_name=excluded.kb_name",
      )
        .bind(accountKey, name, kb.id, kb.name, id, p.credentials)
        .run();
      if (!updated.meta.changes)
        throw new AppError("账号配置已变化，请刷新后重试。", 409);
      return json({ ok: true });
    }
    if (action === "mappings" && request.method === "DELETE") {
      const body = await jsonBody<{ accountKey: unknown }>(request);
      await env.DB.prepare(
        "DELETE FROM mappings WHERE profile_id=? AND account_key=? AND EXISTS (SELECT 1 FROM profiles WHERE id=? AND deleted_at IS NULL AND credentials=?)",
      )
        .bind(id, text(body.accountKey, "公众号标识", 512), id, p.credentials)
        .run();
      return json({ ok: true });
    }
  }
  if (path === "/api/jobs" && request.method === "GET") {
    const profileId = new URL(request.url).searchParams.get("profile");
    if (!profileId) throw new AppError("请选择 IMA 账号。");
    const { results } = await env.DB.prepare(
      "SELECT * FROM jobs WHERE profile_id=? ORDER BY CASE WHEN stage NOT IN ('complete','duplicate','failed') AND (workflow_id IS NOT NULL OR stage<>'queued') THEN 0 ELSE 1 END,updated_at DESC,rowid DESC LIMIT 100",
    )
      .bind(profileId)
      .all<Job>();
    return json({
      jobs: results.map(publicJob),
      queue: await queueSummary(env, profileId),
    });
  }
  if (path === "/api/jobs" && request.method === "POST") {
    const body = await jsonBody<{ profileId: unknown; urls: unknown }>(request);
    const p = requireActiveProfile(
      await profile(env, text(body.profileId, "账号")),
    );
    if (!p.inbox_id)
      throw new AppError("请先在账号设置中选择待分类知识库。", 409);
    // A transport bound keeps one request within Worker limits; the browser chunks any-size batches.
    if (
      !Array.isArray(body.urls) ||
      body.urls.length < 1 ||
      body.urls.length > 100 ||
      body.urls.some((x) => typeof x !== "string")
    )
      throw new AppError(
        "单次接口请求支持 1 至 100 条链接，网页会自动分批提交。",
      );
    const urls = [
      ...new Set(body.urls.map((u: string) => normalizeArticleUrl(u))),
    ];
    const jobs = await enqueueArticles(env, p.id, urls);
    await kickQueue(env);
    return json({ jobs: jobs.map(publicJob) }, 202);
  }
  const jobRoute = path.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(pdf|retry))?$/);
  if (jobRoute) {
    const job = await jobById(env, jobRoute[1] as string);
    if (jobRoute[2] === "pdf" && request.method === "GET") {
      if (job.pdf_deleted_at)
        throw new AppError(
          "备份已过期，网站中的 PDF 已清理；IMA 中的内容不受影响。",
          410,
        );
      if (!job.object_key) throw new AppError("此导入任务尚未保存 PDF。", 404);
      const file = await env.PDFS.get(job.object_key);
      if (!file) throw new AppError("未找到已保存的 PDF。", 404);
      return new Response(file.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(file.size),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.file_name ?? "文章.pdf")}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    if (jobRoute[2] === "retry" && request.method === "POST") {
      requireActiveProfile(await profile(env, job.profile_id));
      if (job.stage !== "failed")
        throw new AppError("仅可重试失败的导入任务。", 409);
      await rateLimit(env, `retry:${job.id}`, 5, 3600);
      const changed = await env.DB.prepare(
        "UPDATE jobs SET stage='queued',error=NULL,attempts=attempts+1,workflow_id=NULL,updated_at=datetime('now') WHERE id=? AND stage='failed' AND EXISTS (SELECT 1 FROM profiles WHERE id=jobs.profile_id AND deleted_at IS NULL)",
      )
        .bind(job.id)
        .run();
      if (!changed.meta.changes)
        throw new AppError("此导入任务已在重试中。", 409);
      await kickQueue(env);
      return json({ job: publicJob(await jobById(env, job.id)) }, 202);
    }
    if (!jobRoute[2] && request.method === "GET")
      return json({ job: publicJob(job) });
  }
  throw new AppError("未找到请求的资源。", 404);
}
export default {
  async scheduled(controller: ScheduledController, env: Env) {
    if (controller.cron === "* * * * *") await dispatchQueue(env);
    else await cleanupExpiredPdfs(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await handle(request, env);
    } catch (error) {
      response = json(
        { error: publicError(error) },
        error instanceof AppError ? error.status : 500,
      );
    }
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
