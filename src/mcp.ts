import { PDFDocument } from "pdf-lib";
import { articleIdentity, assertPublicDownload } from "./article";
import {
  isExplicitMcpRateLimit,
  ProviderRateLimitError,
  parseRetryAfter,
  throwIfProviderRateLimited,
  withProviderRateLimitRetry,
} from "./provider-limits";
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
  body: { method: string; [key: string]: unknown },
  session?: string,
  timeout = 30000,
): Promise<{ data: RpcResult; session: string | null }> {
  const payload = JSON.stringify(body);
  // Retry the rejected RPC only; replaying initialization or conversion as a unit is unsafe.
  return withProviderRateLimitRetry(() =>
    rpcRequest(payload, body.method, session, timeout),
  );
}

async function rpcRequest(
  payload: string,
  operation: string,
  session: string | undefined,
  timeout: number,
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
      body: payload,
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
  await throwIfProviderRateLimited(response, "changfeng", operation);
  if (!response.ok) throw new AppError("文章服务暂时不可用，请稍后重试。", 502);
  // MCP notifications are acknowledged with an empty 202; they have no JSON-RPC result.
  if (
    operation.startsWith("notifications/") &&
    (response.status === 202 || response.status === 204)
  ) {
    await response.body?.cancel();
    return { data: {}, session: response.headers.get("Mcp-Session-Id") };
  }
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
  if (isMcpRateLimit(data))
    throw new ProviderRateLimitError("changfeng", operation, {
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      upstreamStatus: response.status,
    });
  if (data.error || data.result?.isError)
    throw new AppError("文章服务无法获取此文章，请检查链接是否可以访问。", 502);
  return { data, session: response.headers.get("Mcp-Session-Id") };
}

/** Tool errors may be encoded inside text blocks even when the HTTP response is successful. */
function isMcpRateLimit(data: RpcResult): boolean {
  if (data.error && !data.result) return isExplicitMcpRateLimit(data.error);
  const content = data.result?.content;
  if (!Array.isArray(content)) return false;
  let limited = false;
  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;
    let value: unknown;
    try {
      value = JSON.parse(block.text);
    } catch {
      limited ||=
        data.result?.isError === true && isExplicitMcpRateLimit(block.text);
      continue;
    }
    if (data.result?.isError === true)
      limited ||= isExplicitMcpRateLimit(value);
    if (!value || typeof value !== "object") continue;
    const result = value as Record<string, unknown>;
    // A partial/successful conversion must not be replayed because another block is limited.
    if (result.status === "completed" || Array.isArray(result.urls))
      return false;
    limited ||=
      (result.status === "error" || result.status === "failed") &&
      isExplicitMcpRateLimit(result);
  }
  return limited;
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
      response = await withProviderRateLimitRetry(async () => {
        const result = await fetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(90000),
        });
        await throwIfProviderRateLimited(result, "changfeng", "download");
        return result;
      });
    } catch (error) {
      if (error instanceof ProviderRateLimitError) throw error;
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
/** Validate calendar fields before conversion: Date.parse silently rolls invalid days forward. */
function normalizePublishedDate(raw: string): string | null {
  const value = decodeAttribute(raw).trim();
  const beijingDay = (milliseconds: number): string | null => {
    const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
    return Number.isFinite(date.getTime()) &&
      date.getUTCFullYear() > 0 &&
      date.getUTCFullYear() <= 9999
      ? date.toISOString().slice(0, 10)
      : null;
  };
  // Only Unix seconds are accepted; millisecond timestamps and partial years are ambiguous.
  if (/^\d{10}$/.test(value)) return beijingDay(Number(value) * 1000);
  const normalized = value.replace(
    /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    "$1-$2-$3",
  );
  const match = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i,
  );
  if (!match) return null;
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(h ?? 0);
  const minute = Number(min ?? 0);
  const second = Number(sec ?? 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(
    hour,
    minute,
    second,
    Number((fraction ?? "").padEnd(3, "0")),
  );
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  // Unzoned article dates are Beijing wall time, independent of the server's timezone.
  let offset = 8 * 60;
  if (zone?.toUpperCase() === "Z") offset = 0;
  else if (zone) {
    if (zone === "-00:00" || zone === "-0000") return null;
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      return null;
    offset = (hours * 60 + minutes) * (zone.startsWith("-") ? -1 : 1);
  }
  return beijingDay(date.getTime() - offset * 60 * 1000);
}

/** Only inspect article JSON-LD nodes, never dates of nested comments or related content. */
function jsonPublicationDates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonPublicationDates);
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  const dates =
    types.some(
      (type) =>
        typeof type === "string" &&
        /^(?:https?:\/\/schema\.org\/)?(?:Article|NewsArticle|BlogPosting)$/.test(
          type,
        ),
    ) && typeof node.datePublished === "string"
      ? [node.datePublished]
      : [];
  return dates.concat(jsonPublicationDates(node["@graph"]));
}

/** Recognize WeChat's literal top-level ct declaration without executing provider scripts. */
function wechatPublicationDates(script: string): string[] {
  const tokens =
    script
      .match(
        /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g,
      )
      ?.filter((token) => !token.startsWith("//") && !token.startsWith("/*")) ??
    [];
  const dates: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (["{", "(", "["].includes(token)) depth++;
    if (["}", ")", "]"].includes(token)) depth--;
    if (
      depth !== 0 ||
      !["var", "let", "const"].includes(token) ||
      tokens[i + 1] !== "ct" ||
      tokens[i + 2] !== "="
    )
      continue;
    const raw = tokens[i + 3] ?? "";
    let end = i + 4;
    if (tokens[end] === "*" && tokens[end + 1] === "1") end += 2;
    if (end < tokens.length && tokens[end] !== ";") continue;
    dates.push(raw.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return dates;
}

/**
 * Collect explicit publication signals outside article prose. Empty provider placeholders
 * are absent; malformed nonempty signals or disagreements must not invent a publication day.
 * Document text callbacks accumulate split text chunks exactly once, including nested spans.
 */
function publicationCollector(rewriter: HTMLRewriter): () => string | null {
  const dates: string[] = [];
  const captures = new Set<{ text: string }>();
  let ignored = 0;
  rewriter
    .on("*", {
      element(e) {
        if (
          e.getAttribute("id") === "js_content" ||
          ["pre", "code", "template", "noscript"].includes(e.tagName)
        ) {
          ignored++;
          e.onEndTag(() => {
            ignored--;
          });
        }
        if (ignored) return;
        const published =
          e.getAttribute("id") === "publish_time" ||
          (e.getAttribute("itemprop") ?? "")
            .split(/\s+/)
            .includes("datePublished") ||
          (e.tagName === "meta" &&
            ["article:published_time", "datepublished"].includes(
              (
                e.getAttribute("property") ??
                e.getAttribute("name") ??
                ""
              ).toLowerCase(),
            ));
        if (published) {
          const attribute =
            e.getAttribute("content") ?? e.getAttribute("datetime");
          if (attribute !== null) dates.push(attribute);
          else if (e.tagName !== "meta") {
            const capture = { text: "" };
            captures.add(capture);
            e.onEndTag(() => {
              dates.push(capture.text);
              captures.delete(capture);
            });
          }
        }
        if (e.tagName === "script" && !e.getAttribute("src")) {
          const type = (e.getAttribute("type") ?? "").trim().toLowerCase();
          if (
            ![
              "",
              "text/javascript",
              "application/javascript",
              "application/ld+json",
            ].includes(type)
          )
            return;
          const capture = { text: "" };
          captures.add(capture);
          e.onEndTag(() => {
            captures.delete(capture);
            if (type === "application/ld+json") {
              try {
                dates.push(...jsonPublicationDates(JSON.parse(capture.text)));
              } catch {
                /* Malformed JSON is not a publication signal. */
              }
            } else dates.push(...wechatPublicationDates(capture.text));
          });
        }
      },
    })
    .onDocument({
      text(t) {
        if (!ignored) for (const capture of captures) capture.text += t.text;
      },
    });
  return () => {
    const nonempty = dates.filter((date) => decodeAttribute(date).trim());
    const days = new Set(nonempty.map(normalizePublishedDate));
    return days.size === 1 ? (days.values().next().value ?? null) : null;
  };
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
  const publishedDate = publicationCollector(rewriter);
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
  return { ...values, publishedDate: publishedDate(), accountKey, identity };
}
