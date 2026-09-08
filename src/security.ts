import { AppError, type Env } from "./types";

const encoder = new TextEncoder();
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function bytes(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function key(secret: string) {
  if (!secret) throw new AppError("服务器尚未配置加密功能。", 503);
  const material = bytes(secret);
  if (material.length !== 32)
    throw new AppError("服务器尚未配置加密功能。", 503);
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
/** Bind ciphertext to the profile, preventing accidental credential swaps between accounts. */
export async function encrypt(value: unknown, secret: string, profile: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(profile) },
    await key(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `${base64(iv)}.${base64(new Uint8Array(cipher))}`;
}
export async function decrypt<T>(
  value: string,
  secret: string,
  profile: string,
): Promise<T> {
  const [iv, cipher] = value.split(".");
  if (!iv || !cipher) throw new AppError("请重新连接此 IMA 账号。", 409);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(iv), additionalData: encoder.encode(profile) },
    await key(secret),
    bytes(cipher),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export async function passwordHash(
  password: string,
  salt = base64(crypto.getRandomValues(new Uint8Array(16))),
) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytes(salt), iterations: 100000, hash: "SHA-256" },
    material,
    256,
  );
  return `pbkdf2:100000:${salt}:${base64(new Uint8Array(hash))}`;
}
export async function verifyPassword(password: string, hash: string) {
  if (!hash) throw new AppError("网站尚未设置访问口令。", 503);
  const [algorithm, iterations, salt] = hash.split(":");
  if (algorithm !== "pbkdf2" || iterations !== "100000" || !salt)
    throw new AppError("网站访问验证尚未配置。", 503);
  const candidate = await passwordHash(password, salt);
  const a = encoder.encode(candidate),
    b = encoder.encode(hash);
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return different === 0;
}
export async function rateLimit(
  env: Env,
  scope: string,
  limit: number,
  seconds: number,
) {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at < ? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at < ? THEN excluded.expires_at ELSE expires_at END RETURNING count`,
  )
    .bind(scope, expires, now, now)
    .first<{ count: number }>();
  if ((result?.count ?? 0) > limit)
    throw new AppError("请求过于频繁，请稍后重试。", 429);
}
export async function session(request: Request, env: Env) {
  const cookie = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)__Host-wx2ima=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!cookie || !env.ACCESS_PASSWORD_HASH) return null;
  const tokenHash = await digest(`${cookie}:${env.ACCESS_PASSWORD_HASH}`);
  const valid = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(tokenHash, Math.floor(Date.now() / 1000))
    .first();
  return valid ? tokenHash : null;
}
export async function createSession(env: Env) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,expires_at) VALUES (?,?)",
  )
    .bind(
      await digest(`${token}:${env.ACCESS_PASSWORD_HASH}`),
      Math.floor(Date.now() / 1000) + 604800,
    )
    .run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(
      Math.floor(Date.now() / 1000),
    ),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(
      Math.floor(Date.now() / 1000),
    ),
  ]);
  return `__Host-wx2ima=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}
export function checkOrigin(request: Request, env: Env) {
  if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method)) {
    if (request.headers.get("Origin") !== env.APP_ORIGIN)
      throw new AppError("不允许来自此来源的请求。", 403);
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      throw new AppError("请求必须使用 JSON 格式。", 415);
  }
}
export async function jsonBody<T>(request: Request): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("请求内容不能为空。");
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new AppError("请求内容过大。", 413);
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new AppError("JSON 格式无效。");
  }
}
/** Upstream exception text can contain keys and signed URLs; only expose curated messages. */
export function publicError(error: unknown) {
  const fallback = "操作未能完成，请重试。";
  // Workflow steps serialize AppError into Error.message and lose the original prototype.
  const message =
    error instanceof AppError
      ? error.message
      : error instanceof Error && error.message.startsWith("AppError: ")
        ? error.message.replace(/^(?:AppError: )+/, "")
        : "";
  const safe = message.replace(/https?:\/\/\S+/gi, "[link]").trim();
  return /\p{Script=Han}/u.test(safe)
    ? safe.replaceAll("[link]", "[链接已隐藏]").slice(0, 240)
    : fallback;
}
