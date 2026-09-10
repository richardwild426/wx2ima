import { afterEach, expect, spyOn, test } from "bun:test";
import { ima } from "../src/ima";
import { convertArticle } from "../src/mcp";
import {
  ProviderRateLimitError,
  parseRetryAfter,
  throwIfProviderRateLimited,
} from "../src/provider-limits";
import { fetchTarget } from "./helpers";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
});
test("Retry-After accepts seconds and HTTP dates without guessing invalid values", () => {
  const now = Date.UTC(2026, 8, 10, 0, 0, 0);
  expect(parseRetryAfter("120", now)).toBe(120000);
  expect(parseRetryAfter("Thu, 10 Sep 2026 00:02:00 GMT", now)).toBe(120000);
  expect(parseRetryAfter("Wed, 09 Sep 2026 00:00:00 GMT", now)).toBe(0);
  for (const value of [null, "", "-1", "1.5", "tomorrow", "2026-09-10"])
    expect(parseRetryAfter(value, now)).toBeNull();
});
test.each([110021, 20002])(
  "documented IMA throttle code %s is deferred without locally replaying a write",
  async (code) => {
    const remote = spyOn(fetchTarget, "fetch").mockResolvedValue(
      Response.json({ code, msg: "synthetic upstream" }),
    );
    spies.push(remote);
    try {
      await ima(
        { clientId: "synthetic-client", apiKey: "synthetic-key" },
        "add_knowledge",
        {},
      );
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitError);
      expect((error as ProviderRateLimitError).provider).toBe("ima");
    }
    expect(remote).toHaveBeenCalledTimes(1);
  },
);
test("unknown business errors and network failures never become automatic write retries", async () => {
  const remote = spyOn(fetchTarget, "fetch").mockRejectedValue(
    new TypeError("Synthetic network failure"),
  );
  spies.push(remote);
  await expect(
    ima(
      { clientId: "synthetic-client", apiKey: "synthetic-key" },
      "add_knowledge",
      {},
    ),
  ).rejects.not.toBeInstanceOf(ProviderRateLimitError);
  expect(remote).toHaveBeenCalledTimes(1);
  remote.mockResolvedValue(
    Response.json({ code: 999, msg: "synthetic upstream" }),
  );
  await expect(
    ima(
      { clientId: "synthetic-client", apiKey: "synthetic-key" },
      "add_knowledge",
      {},
    ),
  ).rejects.not.toBeInstanceOf(ProviderRateLimitError);
  expect(remote).toHaveBeenCalledTimes(2);
});
test("MCP explicit tool-level rejection is deferred even with HTTP 200", async () => {
  const remote = spyOn(fetchTarget, "fetch").mockImplementation(
    async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(
        request.method === "tools/call"
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Too many requests" }],
              },
            }
          : { jsonrpc: "2.0", id: request.id, result: {} },
        { headers: { "Retry-After": "3600" } },
      );
    },
  );
  spies.push(remote);
  await expect(
    convertArticle("https://mp.weixin.qq.com/s/synthetic"),
  ).rejects.toBeInstanceOf(ProviderRateLimitError);
  expect(remote).toHaveBeenCalledTimes(3);
});
test("rate errors cancel unread responses and never carry upstream secrets", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("synthetic confidential text"));
    },
  });
  const response = new Response(body, {
    status: 429,
    headers: { "Retry-After": "3600" },
  });
  try {
    await throwIfProviderRateLimited(response, "ima", "add_knowledge");
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(String(error)).not.toContain("confidential");
    expect((error as ProviderRateLimitError).retryAfterMs).toBe(3600000);
  }
  expect(response.bodyUsed).toBe(true);
});
