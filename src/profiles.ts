import { knowledgeBases } from "./ima";
import { digest, encrypt, rateLimit } from "./security";
import { profile, publicProfile, requireActiveProfile } from "./store";
import {
  AppError,
  type Credentials,
  type Env,
  type KnowledgeBase,
  type Profile,
} from "./types";

export function inputText(value: unknown, label: string, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(`${label}不能为空，且不能超过 ${max} 个字符。`);
  return value.trim();
}

const idle =
  "NOT EXISTS (SELECT 1 FROM jobs WHERE profile_id=profiles.id AND stage NOT IN ('complete','duplicate','failed'))";
// A new key must still reach configured destinations; checking in the write closes routing races.
const compatible =
  "(profiles.inbox_id IS NULL OR profiles.inbox_id IN (SELECT value FROM json_each(?))) AND NOT EXISTS (SELECT 1 FROM mappings WHERE profile_id=profiles.id AND kb_id NOT IN (SELECT value FROM json_each(?)))";
function baseIds(bases: KnowledgeBase[]) {
  return JSON.stringify(bases.map((base) => base.id));
}
async function credentialConflict(env: Env, id: string): Promise<never> {
  const active = await env.DB.prepare(
    "SELECT id FROM jobs WHERE profile_id=? AND stage NOT IN ('complete','duplicate','failed') LIMIT 1",
  )
    .bind(id)
    .first();
  throw new AppError(
    active
      ? "此账号有正在导入的任务，请等任务结束后再更新凭据或删除账号。"
      : "账号配置已变化，或新凭据无法访问已配置的知识库。请刷新并检查分配规则后重试。",
    409,
  );
}
interface ProfileInput {
  name?: unknown;
  ownerName?: unknown;
  clientId?: unknown;
  apiKey?: unknown;
}
export async function connectProfile(env: Env, body: ProfileInput) {
  await rateLimit(env, "connect-profiles", 20, 3600);
  const name = inputText(body?.name, "账号名称", 80);
  const owner = inputText(body?.ownerName, "账号所有者姓名", 80);
  const c = {
    clientId: inputText(body.clientId, "客户端标识", 512),
    apiKey: inputText(body.apiKey, "接口密钥", 2048),
  };
  const bases = await knowledgeBases(c);
  const fingerprint = await digest(c.clientId);
  const prior = await env.DB.prepare(
    "SELECT id FROM profiles WHERE client_fingerprint=?",
  )
    .bind(fingerprint)
    .first<{ id: string }>();
  // The identity is stable across concurrent connections and reconnection after deletion.
  const id = prior?.id ?? fingerprint;
  const sealed = await encrypt(c, env.ENCRYPTION_KEY, id);
  const ids = baseIds(bases);
  const result = await env.DB.prepare(
    `INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials,kb_count) VALUES (?,?,?,?,?,?) ON CONFLICT(client_fingerprint) DO UPDATE SET name=excluded.name,owner_name=excluded.owner_name,credentials=excluded.credentials,kb_count=excluded.kb_count,verified_at=datetime('now'),deleted_at=NULL WHERE ${idle} AND ${compatible}`,
  )
    .bind(id, name, owner, fingerprint, sealed, bases.length, ids, ids)
    .run();
  if (!result.meta.changes) await credentialConflict(env, id);
  return {
    profile: publicProfile(await profile(env, id)),
    knowledgeBases: bases,
  };
}
export async function editProfile(env: Env, p: Profile, body: ProfileInput) {
  requireActiveProfile(p);
  const name = inputText(body?.name, "账号名称", 80);
  const owner = inputText(body?.ownerName, "账号所有者姓名", 80);
  const supplied = (value: unknown) => value !== undefined && value !== "";
  let result: D1Result;
  let bases: KnowledgeBase[] | undefined;
  if (supplied(body.clientId) || supplied(body.apiKey)) {
    if (!supplied(body.clientId) || !supplied(body.apiKey))
      throw new AppError("更新凭据时，请同时填写 Client ID 和 API key。");
    const c: Credentials = {
      clientId: inputText(body.clientId, "客户端标识", 512),
      apiKey: inputText(body.apiKey, "接口密钥", 2048),
    };
    if ((await digest(c.clientId)) !== p.client_fingerprint)
      throw new AppError("Client ID 属于其他账号，请使用添加账号功能。", 409);
    await rateLimit(env, "connect-profiles", 20, 3600);
    bases = await knowledgeBases(c);
    const sealed = await encrypt(c, env.ENCRYPTION_KEY, p.id);
    const ids = baseIds(bases);
    // The ciphertext comparison prevents a slow verification from overwriting a newer edit.
    result = await env.DB.prepare(
      `UPDATE profiles SET name=?,owner_name=?,credentials=?,kb_count=?,verified_at=datetime('now') WHERE id=? AND deleted_at IS NULL AND credentials=? AND ${idle} AND ${compatible}`,
    )
      .bind(name, owner, sealed, bases.length, p.id, p.credentials, ids, ids)
      .run();
  } else {
    result = await env.DB.prepare(
      "UPDATE profiles SET name=?,owner_name=? WHERE id=? AND deleted_at IS NULL",
    )
      .bind(name, owner, p.id)
      .run();
  }
  if (!result.meta.changes) await credentialConflict(env, p.id);
  return {
    profile: publicProfile(await profile(env, p.id)),
    ...(bases ? { knowledgeBases: bases } : {}),
  };
}
export async function deleteProfile(env: Env, p: Profile) {
  requireActiveProfile(p);
  // Retain the identity, archives and deduplication ledger, but erase the usable credential.
  // The transaction and conditional write serialize deletion with job admission and retry.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE profiles SET credentials='',inbox_id=NULL,inbox_name=NULL,kb_count=0,deleted_at=datetime('now') WHERE id=? AND deleted_at IS NULL AND ${idle}`,
    ).bind(p.id),
    env.DB.prepare(
      "DELETE FROM mappings WHERE profile_id=? AND EXISTS (SELECT 1 FROM profiles WHERE id=? AND deleted_at IS NOT NULL)",
    ).bind(p.id, p.id),
  ]);
  if (!results[0]?.meta.changes) await credentialConflict(env, p.id);
  return { ok: true, profile: publicProfile(await profile(env, p.id)) };
}
