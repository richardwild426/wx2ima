import { AppError } from "./types";

export type Provider = "ima" | "changfeng" | "cos";

/** Largest epoch that Date and durable queue serialization can represent. */
export const MAX_PROVIDER_RETRY_AT = 8640000000000000;

/** Local retry budgets, not published provider quotas. Global admission belongs in D1. */
export const PROVIDER_RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  maxTotalDelayMs: 15000,
});

/** Accept HTTP delay-seconds and all three HTTP-date forms, not arbitrary Date.parse input. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text))
    return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const time = "\\d{2}:\\d{2}:\\d{2}";
  const httpDate = new RegExp(
    `^(?:${day}, \\d{2} ${month} \\d{4} ${time} GMT|` +
      `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT|` +
      `${day} ${month} [ \\d]\\d ${time} \\d{4})$`,
  );
  if (!httpDate.test(text)) return null;
  // asctime omits the zone, but HTTP dates always use UTC.
  const date = Date.parse(text.endsWith("GMT") ? text : `${text} GMT`);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

interface RateLimitDetails {
  retryAfterMs?: number | null;
  upstreamStatus?: number;
  providerCode?: number | string;
  safeToRetry?: boolean;
}

/**
 * Only construct for an explicit rejection due to throttling. Never store upstream
 * messages, URLs, credentials or response bodies here. A queue can persist retryAt
 * (epoch milliseconds) and resume this operation, rather than replay a whole import.
 * safeToRetry also requires a replayable request body; COS streams are single-use.
 */
export class ProviderRateLimitError extends AppError {
  readonly retryAfterMs: number | null;
  readonly upstreamStatus?: number;
  readonly providerCode?: number | string;
  readonly safeToRetry: boolean;
  readonly blocked: boolean;
  attempts = 1;
  retryAt: number;

  constructor(
    public readonly provider: Provider,
    public readonly operation: string,
    details: RateLimitDetails = {},
  ) {
    super("第三方服务请求过于频繁，请稍后重试。", 429);
    this.name = "ProviderRateLimitError";
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.upstreamStatus = details.upstreamStatus;
    this.providerCode = details.providerCode;
    const retryAt =
      Date.now() +
      Math.max(
        this.retryAfterMs ?? 0,
        PROVIDER_RETRY_POLICY.baseDelayMs + Math.floor(Math.random() * 250),
      );
    this.blocked = !Number.isFinite(retryAt) || retryAt > MAX_PROVIDER_RETRY_AT;
    this.safeToRetry = !this.blocked && (details.safeToRetry ?? true);
    this.retryAt = this.blocked ? MAX_PROVIDER_RETRY_AT : retryAt;
    if (this.blocked)
      this.message = "第三方服务要求的等待时间超出支持范围，已暂停自动重试。";
  }
}

/** Release rejected responses before backing off, even when their bodies are not JSON. */
export async function throwIfProviderRateLimited(
  response: Response,
  provider: Provider,
  operation: string,
  safeToRetry = true,
): Promise<void> {
  if (response.status !== 429) return;
  const error = new ProviderRateLimitError(provider, operation, {
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    upstreamStatus: response.status,
    safeToRetry,
  });
  await response.body?.cancel().catch(() => {});
  throw error;
}

/**
 * Retry only an explicitly rejected, replayable request. Network failures, 5xx,
 * parsing failures and unknown business errors may hide a committed write.
 * Never shorten Retry-After to fit the budget: hand long waits back to the queue.
 * Durable callers use the default (no sleeping); local retries require explicit opt-in.
 */
export async function withProviderRateLimitRetry<T>(
  request: () => Promise<T>,
  options: { retryLocally?: boolean } = {},
): Promise<T> {
  if (!options.retryLocally) return request();
  let totalDelayMs = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof ProviderRateLimitError)) throw error;
      error.attempts = attempt + 1;
      const backoff = PROVIDER_RETRY_POLICY.baseDelayMs * 2 ** attempt;
      const delay = Math.max(
        error.retryAfterMs ?? 0,
        backoff + Math.floor(Math.random() * 250),
      );
      error.retryAt = Math.min(MAX_PROVIDER_RETRY_AT, Date.now() + delay);
      if (
        !error.safeToRetry ||
        attempt >= PROVIDER_RETRY_POLICY.maxRetries ||
        delay > PROVIDER_RETRY_POLICY.maxDelayMs ||
        totalDelayMs + delay > PROVIDER_RETRY_POLICY.maxTotalDelayMs
      )
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      totalDelayMs += delay;
    }
  }
}

/**
 * Apply only to an MCP error payload, never successful article content. No public
 * Changfeng numeric error catalogue is available; generic busy/timeout errors
 * and unknown JSON-RPC codes do not establish that a conversion was rejected.
 */
export function isExplicitMcpRateLimit(error: unknown): boolean {
  if (typeof error === "string")
    return /\btoo many requests\b|\brate[ _-]?limit(?:ed| exceeded| reached)\b|请求频控|(?:请求|访问)(?:过于|太)?频繁|触发限流|超过.{0,8}(?:请求频率|并发)限制/i.test(
      error,
    );
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === 429 ||
    value.code === "429" ||
    value.code === "RATE_LIMITED" ||
    value.code === "RATE_LIMIT_EXCEEDED" ||
    value.code === "TOO_MANY_REQUESTS" ||
    value.status === 429 ||
    isExplicitMcpRateLimit(value.message) ||
    isExplicitMcpRateLimit(value.msg) ||
    (typeof value.error === "string" && isExplicitMcpRateLimit(value.error))
  );
}
