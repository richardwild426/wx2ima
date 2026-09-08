import { createHash, createHmac } from "node:crypto";
import { AppError, type Credentials, type KnowledgeBase } from "./types";

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
}
export async function ima<T>(
  credentials: Credentials,
  endpoint: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://ima.qq.com/openapi/wiki/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ima-openapi-clientid": credentials.clientId,
        "ima-openapi-apikey": credentials.apiKey,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new AppError("IMA 未响应，请先检查导入状态再重试。", 502);
  }
  if (!response.ok)
    throw new AppError(
      response.status === 401 || response.status === 403
        ? "IMA 账号凭据验证失败，请重新连接账号。"
        : "IMA 暂时不可用，请稍后重试。",
      502,
    );
  let result: Envelope<T>;
  try {
    result = await response.json();
  } catch {
    throw new AppError("无法解析 IMA 返回的数据。", 502);
  }
  if (result.code !== 0) {
    // Remove any credential echo or signed URL before presenting an upstream business error.
    let message = typeof result.msg === "string" ? result.msg : "";
    for (const value of [credentials.apiKey, credentials.clientId].sort(
      (a, b) => b.length - a.length,
    ))
      if (value) message = message.split(value).join("[redacted]");
    message = message.replace(/https?:\/\/\S+/gi, "[link]").trim();
    // Preserve actionable Chinese errors; do not guess the meaning of unknown English errors.
    message = /\p{Script=Han}/u.test(message)
      ? message
          .replaceAll("[redacted]", "[凭据已隐藏]")
          .replaceAll("[link]", "[链接已隐藏]")
          .slice(0, 240)
      : "请求未能完成，请检查账号凭据、知识库权限和提交内容后重试。";
    throw new AppError(`IMA：${message}`, 422);
  }
  return result.data;
}
export async function knowledgeBases(c: Credentials): Promise<KnowledgeBase[]> {
  const all: KnowledgeBase[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const data = await ima<{
      addable_knowledge_base_list?: KnowledgeBase[];
      next_cursor?: string;
      is_end?: boolean;
    }>(c, "get_addable_knowledge_base_list", { cursor, limit: 50 });
    const list = data.addable_knowledge_base_list;
    if (!Array.isArray(list))
      throw new AppError("IMA 返回的知识库数据格式不受支持。", 502);
    for (const item of list)
      if (item.id && item.name) all.push({ id: item.id, name: item.name });
    if (data.is_end === true) return all;
    if (!data.next_cursor || data.next_cursor === cursor)
      throw new AppError("无法继续获取 IMA 知识库列表的下一页。", 502);
    cursor = data.next_cursor;
  }
  throw new AppError("此 IMA 账号的知识库过多，无法一次列出全部知识库。", 422);
}
export async function validateBase(c: Credentials, id: string) {
  const list = await knowledgeBases(c);
  const kb = list.find((k) => k.id === id);
  if (!kb) throw new AppError("此知识库已无法写入，请更新账号设置。", 409);
  return kb;
}
interface KnowledgeItem {
  media_id: string;
  title: string;
}
export async function findExact(
  c: Credentials,
  kbId: string,
  title: string,
  mediaId?: string,
): Promise<KnowledgeItem | null> {
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const data = await ima<{
      knowledge_list?: KnowledgeItem[];
      next_cursor?: string;
      is_end?: boolean;
    }>(c, "get_knowledge_list", { knowledge_base_id: kbId, cursor, limit: 50 });
    if (!Array.isArray(data.knowledge_list))
      throw new AppError("IMA 返回的知识列表数据格式不受支持。", 502);
    const item = data.knowledge_list.find((x) =>
      mediaId ? x.media_id === mediaId : x.title === title,
    );
    if (item) return item;
    if (data.is_end === true) return null;
    if (!data.next_cursor || cursor === data.next_cursor)
      throw new AppError("无法继续核验 IMA 导入结果。", 502);
    cursor = data.next_cursor;
  }
  throw new AppError(
    "目标知识库内容过多，无法完成 IMA 导入核验，请选择内容较少的知识库。",
    422,
  );
}
export async function repeatedName(c: Credentials, kbId: string, name: string) {
  const data = await ima<{
    results?: { is_repeated?: boolean }[];
  }>(c, "check_repeated_names", {
    knowledge_base_id: kbId,
    params: [{ name, media_type: 1 }],
  });
  const list = data.results;
  if (
    !Array.isArray(list) ||
    list.length !== 1 ||
    typeof list[0]?.is_repeated !== "boolean"
  )
    throw new AppError("IMA 返回的重名检查数据格式不受支持。", 502);
  return list[0].is_repeated;
}
export interface CosCredential {
  secret_id: string;
  secret_key: string;
  token: string;
  bucket_name: string;
  region: string;
  cos_key: string;
  start_time: number;
  expired_time: number;
}
export interface Media {
  media_id: string;
  cos_credential: CosCredential;
}
export function cosAuthorization(c: CosCredential, size: number) {
  const host = `${c.bucket_name}.cos.${c.region}.myqcloud.com`;
  const pathname = `/${c.cos_key}`;
  const keyTime = `${c.start_time};${c.expired_time}`;
  const signKey = createHmac("sha1", c.secret_key)
    .update(keyTime)
    .digest("hex");
  const headers = `content-length=${size}&host=${encodeURIComponent(host)}`;
  const httpString = `put\n${pathname}\n\n${headers}\n`;
  const toSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(toSign).digest("hex");
  return {
    host,
    pathname,
    authorization: `q-sign-algorithm=sha1&q-ak=${c.secret_id}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`,
  };
}
export async function uploadCos(
  c: CosCredential,
  body: ReadableStream,
  size: number,
) {
  if (
    !/^[a-z0-9-]+$/.test(c.bucket_name) ||
    !/^[-a-z0-9]+$/.test(c.region) ||
    !c.cos_key ||
    c.cos_key.includes("?") ||
    c.cos_key.includes("#") ||
    c.cos_key.split("/").includes("..")
  )
    throw new AppError("IMA 返回的上传信息无效。", 502);
  const { host, pathname, authorization } = cosAuthorization(c, size);
  // COS signs Content-Length; Workers only guarantee that header for a fixed-length body.
  const fixed = new FixedLengthStream(size);
  const transfer = body.pipeTo(fixed.writable);
  const [response] = await Promise.all([
    fetch(
      `https://${host}${pathname.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        body: fixed.readable,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(size),
          Authorization: authorization,
          "x-cos-security-token": c.token,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
      },
    ),
    transfer,
  ]);
  if (!response.ok)
    throw new AppError(
      "PDF 上传至 IMA 存储失败，可使用已保存的 PDF 重试。",
      502,
    );
  await response.body?.cancel();
}
