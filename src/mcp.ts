import { PDFDocument } from "pdf-lib";
import { articleIdentity, assertPublicDownload } from "./article";
import { AppError } from "./types";

const ENDPOINT = "https://changfengbox.top/api/mcp";
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
interface RpcResult {
  error?: unknown;
  result?: {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    protocolVersion?: string;
  };
}
export async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new AppError("文件超过网站允许的大小限制。", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("下载服务返回了空文件。", 502);
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new AppError("文件超过网站允许的大小限制。", 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
async function rpc(
  body: unknown,
  session?: string,
  timeout = 30000,
): Promise<{ data: RpcResult; session: string | null }> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
    });
  } catch (error) {
    console.warn("article_service_transport_failed", {
      reason:
        error instanceof Error
          ? error.message.replace(/https?:\/\/\S+/g, "[remote]").slice(0, 160)
          : "Unknown transport error",
    });
    throw new AppError("文章服务未响应，请重试导入。", 502);
  }
  if (!response.ok) throw new AppError("文章服务暂时不可用，请稍后重试。", 502);
  const text = new TextDecoder().decode(
    await readLimited(response, 1024 * 1024),
  );
  let data: RpcResult = {};
  try {
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const content = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (content) {
          const parsed = JSON.parse(content) as RpcResult;
          if (parsed.result || parsed.error) data = parsed;
        }
      }
    } else if (text.trim()) {
      data = JSON.parse(text) as RpcResult;
    }
  } catch {
    throw new AppError("无法解析文章服务返回的数据。", 502);
  }
  if (data.error || data.result?.isError)
    throw new AppError("文章服务无法获取此文章，请检查链接是否可以访问。", 502);
  return { data, session: response.headers.get("Mcp-Session-Id") };
}
export function parseDownloadResult(data: RpcResult): {
  pdf: string;
  html: string;
} {
  for (const block of data.result?.content ?? []) {
    if (block.type !== "text" || !block.text) continue;
    let value: { status?: string; urls?: unknown };
    try {
      value = JSON.parse(block.text);
    } catch {
      continue;
    }
    if (value.status !== "completed" || !Array.isArray(value.urls)) continue;
    const urls = value.urls.filter((v): v is string => typeof v === "string");
    const pdf = urls.find((u) => {
      try {
        return new URL(u).pathname.toLowerCase().endsWith(".pdf");
      } catch {
        return false;
      }
    });
    const html = urls.find((u) => {
      try {
        return /\.html?$/i.test(new URL(u).pathname);
      } catch {
        return false;
      }
    });
    if (pdf && html) {
      assertPublicDownload(pdf);
      assertPublicDownload(html);
      return { pdf, html };
    }
  }
  throw new AppError("文章服务未同时返回 PDF 和文章信息。", 502);
}
export async function convertArticle(url: string) {
  const initialized = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "wx2ima", version: "0.1.0" },
    },
  });
  const session = initialized.session ?? undefined;
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wechat",
        arguments: {
          url,
          config: {
            PDF: true,
            HTML: true,
            MD: false,
            WORD: false,
            TXT: false,
            MHTML: false,
          },
        },
      },
    },
    session,
    180000,
  );
  return parseDownloadResult(response.data);
}
export async function download(url: string, limit: number) {
  let target = assertPublicDownload(url);
  for (let i = 0; i < 3; i++) {
    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      throw new AppError("文章文件下载失败，请重试。", 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) break;
      target = assertPublicDownload(new URL(location, target).href);
      continue;
    }
    if (!response.ok)
      throw new AppError("文章下载链接已过期或不可用，请重试。", 502);
    return await readLimited(response, limit);
  }
  throw new AppError("文章服务的重定向次数过多。", 502);
}
export async function validatePdf(bytes: Uint8Array) {
  if (
    bytes.byteLength < 100 ||
    bytes.byteLength > MAX_PDF_BYTES ||
    !new TextDecoder().decode(bytes.slice(0, 8)).startsWith("%PDF-")
  )
    throw new AppError("下载的文件不是有效的 PDF。", 502);
  try {
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (doc.isEncrypted || doc.getPageCount() < 1) throw new Error("Invalid");
    return doc.getPageCount();
  } catch {
    throw new AppError("下载的 PDF 已损坏或加密。", 502);
  }
}
/** HTMLRewriter exposes raw attribute entities; decode before comparing canonical URLs. */
function decodeAttribute(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const numeric = entity.toLowerCase().startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return numeric > 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : whole;
    },
  );
}
/** The provider strips some WeChat metadata. Only use account IDs when actually present. */
export async function metadata(html: Uint8Array, sourceUrl: string) {
  const values: {
    title: string;
    publisher: string;
    canonical: string;
    date: string;
  } = { title: "", publisher: "", canonical: "", date: "" };
  const rewriter = new HTMLRewriter()
    .on('meta[property="og:title"]', {
      element(e) {
        values.title = e.getAttribute("content") ?? "";
      },
    })
    .on('meta[property="og:url"]', {
      element(e) {
        values.canonical = e.getAttribute("content") ?? "";
      },
    })
    .on("#js_name", {
      text(t) {
        values.publisher += t.text;
      },
    })
    .on("#publish_time", {
      text(t) {
        values.date += t.text;
      },
    });
  await rewriter.transform(new Response(new TextDecoder().decode(html))).text();
  const text = new TextDecoder().decode(html);
  values.publisher = values.publisher.trim();
  values.title = decodeAttribute(values.title).trim();
  values.canonical = decodeAttribute(values.canonical).trim();
  const hasArticleBody = /id\s*=\s*["']js_content["']/.test(text);
  if (
    !values.title ||
    (!values.publisher &&
      !hasArticleBody &&
      /^(环境异常|验证|访问过于频繁)$/.test(values.title))
  )
    throw new AppError("文章服务返回了验证页面，未获取到文章内容。", 502);
  if (values.canonical) {
    try {
      const canonical = new URL(values.canonical);
      if (canonical.hostname !== "mp.weixin.qq.com")
        throw new Error("Mismatch");
      const input = new URL(sourceUrl);
      const inputIdentity = articleIdentity(input.href);
      const returnedIdentity = articleIdentity(canonical.href);
      if (
        inputIdentity &&
        returnedIdentity &&
        inputIdentity !== returnedIdentity
      )
        throw new Error("Mismatch");
      if (
        input.pathname.startsWith("/s/") &&
        canonical.pathname.startsWith("/s/") &&
        input.pathname !== canonical.pathname
      )
        throw new Error("Mismatch");
    } catch {
      throw new AppError("下载的文章与提交的链接不一致。", 502);
    }
  }
  const source = new URL(sourceUrl);
  const htmlBiz = text.match(
    /(?:var\s+biz|__biz)\s*[:=]\s*["']([^"']+)["']/,
  )?.[1];
  if (
    htmlBiz &&
    source.searchParams.get("__biz") &&
    htmlBiz !== source.searchParams.get("__biz")
  )
    throw new AppError("下载的文章所属公众号与提交的链接不一致。", 502);
  const biz = source.searchParams.get("__biz") || htmlBiz;
  const accountKey = biz
    ? `biz:${biz}`
    : values.publisher
      ? `name:${values.publisher.normalize("NFKC")}`
      : null;
  const identity =
    articleIdentity(sourceUrl) ||
    (values.canonical ? articleIdentity(values.canonical) : null);
  return { ...values, accountKey, identity };
}
