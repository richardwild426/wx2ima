import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  articleIdentity,
  assertPublicDownload,
  fileName,
  normalizeArticleUrl,
} from "../src/article";
import { findExact, knowledgeBases, repeatedName } from "../src/ima";
import {
  metadata,
  parseDownloadResult,
  readLimited,
  validatePdf,
} from "../src/mcp";
import {
  checkOrigin,
  createSession,
  decrypt,
  encrypt,
  passwordHash,
  rateLimit,
  session,
  verifyPassword,
} from "../src/security";
import { fetchTarget, testEnv } from "./helpers";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
});
describe("article boundary", () => {
  test("normalizes tracking without changing article identity", () => {
    expect(
      normalizeArticleUrl("https://mp.weixin.qq.com/s/Abc?scene=1#read"),
    ).toBe("https://mp.weixin.qq.com/s/Abc");
    const a = normalizeArticleUrl(
      "https://mp.weixin.qq.com/s?__biz=B&mid=123&idx=1&sn=S&scene=3",
    );
    expect(articleIdentity(a)).toBe("wx:B:123:1");
    expect(a).not.toContain("scene");
  });
  test("rejects SSRF, userinfo, incomplete links and collections", () => {
    for (const u of [
      "http://mp.weixin.qq.com/s/a",
      "https://mp.weixin.qq.com.evil.org/s/a",
      "https://evil@mp.weixin.qq.com/s/a",
      "https://127.0.0.1/s/a",
      "https://mp.weixin.qq.com/mp/appmsgalbum",
      "https://mp.weixin.qq.com/s?__biz=B",
    ])
      expect(() => normalizeArticleUrl(u)).toThrow();
  });
  test("download hosts require an exact trusted suffix", () => {
    expect(() =>
      assertPublicDownload("https://changfengbox.top/file.pdf"),
    ).not.toThrow();
    for (const u of [
      "https://changfengbox.top.evil.org/a.pdf",
      "http://changfengbox.top/a.pdf",
      "https://127.0.0.1/a.pdf",
    ])
      expect(() => assertPublicDownload(u)).toThrow();
  });
  test("filenames stay valid for Chinese titles and path characters", () => {
    const result = fileName(`${"中".repeat(100)}/../title\u0000`, "2026-09-08");
    expect(new TextEncoder().encode(result).length).toBeLessThan(210);
    expect(result).toBe(`2026-09-08_${"中".repeat(53)}.pdf`);
    expect(fileName("文章标题", "2026-09-08")).toBe("2026-09-08_文章标题.pdf");
    expect(fileName("文章标题", "2026-09-08", 2)).toBe(
      "2026-09-08_文章标题（2）.pdf",
    );
    expect(result).not.toContain("/");
    expect(result).not.toContain("\u0000");
  });
});
describe("credentials and sessions", () => {
  test("encrypted credentials cannot be decrypted by another profile", async () => {
    const { env } = testEnv();
    const ciphertext = await encrypt(
      { apiKey: "synthetic test value" },
      env.ENCRYPTION_KEY,
      "one",
    );
    expect(ciphertext).not.toContain("synthetic");
    expect(
      await decrypt<{ apiKey: string }>(ciphertext, env.ENCRYPTION_KEY, "one"),
    ).toEqual({
      apiKey: "synthetic test value",
    });
    expect(decrypt(ciphertext, env.ENCRYPTION_KEY, "two")).rejects.toThrow();
  });
  test("passwords are salted and checked, never stored as plaintext", async () => {
    const hash = await passwordHash("test passphrase");
    expect(hash).not.toContain("test passphrase");
    expect(await verifyPassword("test passphrase", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await passwordHash("test passphrase")).not.toBe(hash);
  });
  test("session cookie is private, revocable and invalidated on password rotation", async () => {
    const { env } = testEnv();
    env.ACCESS_PASSWORD_HASH = await passwordHash("temporary test");
    const cookie = await createSession(env);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
    const req = new Request(env.APP_ORIGIN, { headers: { Cookie: cookie } });
    expect(await session(req, env)).toBeTruthy();
    env.ACCESS_PASSWORD_HASH = await passwordHash("rotated test");
    expect(await session(req, env)).toBeNull();
  });
  test("cross-origin writes are rejected", () => {
    const { env } = testEnv();
    expect(() =>
      checkOrigin(
        new Request(env.APP_ORIGIN, {
          method: "POST",
          headers: {
            Origin: "https://elsewhere.test",
            "Content-Type": "application/json",
          },
        }),
        env,
      ),
    ).toThrow();
  });
  test("database rate limiting stops brute force attempts", async () => {
    const { env } = testEnv();
    await rateLimit(env, "test", 2, 60);
    await rateLimit(env, "test", 2, 60);
    expect(rateLimit(env, "test", 2, 60)).rejects.toThrow("请求过于频繁");
  });
});
describe("provider contract", () => {
  test("parses nested MCP text JSON, requiring both metadata and PDF", () => {
    const result = {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "completed",
              urls: [
                "https://changfengbox.top/a.html",
                "https://changfengbox.top/a.pdf",
              ],
            }),
          },
        ],
      },
    };
    expect(parseDownloadResult(result)).toEqual({
      html: "https://changfengbox.top/a.html",
      pdf: "https://changfengbox.top/a.pdf",
    });
    expect(() => parseDownloadResult({ result: { content: [] } })).toThrow();
  });
  test("does not invent publisher IDs and rejects mismatched articles", async () => {
    const html = new TextEncoder().encode(
      '<meta property="og:title" content="A real article"><meta property="og:url" content="https://mp.weixin.qq.com/s/abc"><span id="js_name">Publisher</span>',
    );
    const data = await metadata(html, "https://mp.weixin.qq.com/s/abc");
    expect(data.accountKey).toBe("name:Publisher");
    expect(data.title).toBe("A real article");
    expect(metadata(html, "https://mp.weixin.qq.com/s/other")).rejects.toThrow(
      "与提交的链接不一致",
    );
  });
  test("rejects a fake PDF and checks actual PDF structure", async () => {
    expect(
      validatePdf(new TextEncoder().encode("<html>Not a PDF</html>")),
    ).rejects.toThrow();
    const pdf = await PDFDocument.create();
    pdf.addPage();
    expect(await validatePdf(await pdf.save())).toBe(1);
  });
  test("enforces streamed download size rather than trusting Content-Length", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(32));
        c.close();
      },
    });
    expect(readLimited(new Response(stream), 16)).rejects.toThrow("大小限制");
  });
});
describe("article publication dates", () => {
  async function publishedDate(fragment: string) {
    const result = await metadata(
      new TextEncoder().encode(
        `<meta property="og:title" content="Publication fixture">${fragment}`,
      ),
      "https://mp.weixin.qq.com/s/publication-fixture",
    );
    return result.publishedDate;
  }

  test("normalizes the real provider's Chinese date and empty duplicate placeholder", async () => {
    expect(
      await publishedDate(`
      <em class="rich_media_meta rich_media_meta_text" id="publish_time">
        2026年07月01日 06:56
      </em>
      <em class="rich_media_meta rich_media_meta_text" id="publish_time"> </em>
    `),
    ).toBe("2026-07-01");
  });

  test.each([
    ["2026-7-1", "2026-07-01"],
    ["2026年7月1日", "2026-07-01"],
    ["2024年2月29日 23:59:59", "2024-02-29"],
    ["2026-07-01 23:59", "2026-07-01"],
    ["2026-07-01T16:30:00Z", "2026-07-02"],
    ["2026-01-01T00:30:00+14:00", "2025-12-31"],
    ["2026-12-31T23:59:59.123-0500", "2027-01-01"],
    ["2026-07-01T00:30:00+08:00", "2026-07-01"],
    ["1782921600", "2026-07-02"],
  ])("normalizes %s to Beijing day %s", async (input, expected) => {
    expect(await publishedDate(`<em id="publish_time">${input}</em>`)).toBe(
      expected,
    );
  });

  test.each([
    "",
    " ",
    "2026",
    "2026-07",
    "07-01",
    "7月1日",
    "昨天 06:56",
    "2026-02-29",
    "2024-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-07-00",
    "0000-01-01",
    "2026-07-01 24:00",
    "2026-07-01 12:60",
    "2026-07-01T12:30:60Z",
    "2026-07-01T12:30:00+14:01",
    "2026-07-01T12:30:00+08:60",
    "2026-07-01T12:30:00+25:00",
    "2026-07-01T12:30:00-00:00",
    "1782921600000",
    "NaN",
    "Published on 2026-07-01; downloaded 2026-09-09",
  ])("rejects incomplete or invalid publication value %j", async (input) => {
    expect(
      await publishedDate(`<em id="publish_time">${input}</em>`),
    ).toBeNull();
  });

  test.each([
    '<meta property="article:published_time" content="2026-07-01T16:30:00Z">',
    '<meta name="datePublished" content="2026-07-02">',
    '<meta itemprop="datePublished" content="2026-07-02">',
    '<time itemprop="datePublished" datetime="2026-07-01T16:30:00Z">July 2</time>',
    '<span itemprop="datePublished"><b>2026年</b>7月2日&nbsp;06:56</span>',
    '<em id="publish_time">2026&#24180;07&#26376;02&#26085;</em>',
    '<script>var ct = "1782921600";</script>',
    "<script>var ct = '1782921600' * 1;</script>",
    "<script>const ct = 1782921600;</script>",
    '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-07-02","dateModified":"2026-09-09"}</script>',
    '<script type="application/ld+json">{"@graph":[{"@type":"WebSite","datePublished":"2020-01-01"},{"@type":["Article"],"datePublished":"2026-07-02","comment":{"datePublished":"2026-09-09"}}]}</script>',
  ])("accepts explicit publication metadata: %s", async (fragment) => {
    expect(await publishedDate(fragment)).toBe("2026-07-02");
  });

  test.each([
    "",
    '<p>Publication date: 2026-07-01</p><time datetime="2026-07-01">2026-07-01</time>',
    '<meta property="article:modified_time" content="2026-07-01"><meta name="date" content="2026-07-01"><time itemprop="dateModified">2026-07-01</time>',
    "<p>Downloaded: 2026-09-09</p><script>var download_time = 1782921600; var modify_time = 1782921600;</script>",
    '<div id="js_content"><em id="publish_time">2026-07-01</em><meta itemprop="datePublished" content="2026-07-01"><script>var ct = 1782921600;</script></div>',
    '<pre>var ct = 1782921600;</pre><code><time itemprop="datePublished">2026-07-01</time></code>',
    '<script>// var ct = 1782921600;\n/* var ct = 1782921600; */ const example = "var ct = 1782921600;";</script>',
    "<script>const nested = {ct: 1782921600}; function example() { var ct = 1782921600; }</script>",
    '<script type="application/json">{"ct":1782921600,"datePublished":"2026-07-01"}</script>',
    '<script type="application/ld+json">{"@type":"Comment","datePublished":"2026-07-01"}</script>',
    '<script type="application/ld+json">{invalid json}</script>',
  ])(
    "ignores absent, body, modification and download dates: %s",
    async (fragment) => {
      expect(await publishedDate(fragment)).toBeNull();
    },
  );

  test("compares independent signals after Beijing conversion", async () => {
    expect(
      await publishedDate(
        '<em id="publish_time">2026-07-02</em><meta property="article:published_time" content="2026-07-01T16:30:00Z"><script>var ct = 1782921600;</script>',
      ),
    ).toBe("2026-07-02");
    expect(
      await publishedDate(
        '<em id="publish_time">2026-07-01</em><em id="publish_time">2026-07-01</em>',
      ),
    ).toBe("2026-07-01");
    expect(
      await publishedDate(
        '<div id="js_content"><time itemprop="datePublished">2000-01-01</time></div><em id="publish_time">2026-07-01</em>',
      ),
    ).toBe("2026-07-01");
  });

  test.each([
    '<em id="publish_time">2026-07-01</em><meta property="article:published_time" content="2026-07-02">',
    '<em id="publish_time">2026-07-01</em><em id="publish_time">2026-07-02</em>',
    '<meta name="datePublished" content="2026-07-01"><meta name="datePublished" content="2026-07-02">',
    '<em id="publish_time">2026-07-01</em><script>var ct = 1782921600;</script>',
    '<em id="publish_time">7月1日</em><meta name="datePublished" content="2026-07-01">',
    '<em id="publish_time">2026-02-30</em><meta name="datePublished" content="2026-03-02">',
  ])(
    "fails closed for conflicting or incomplete signals: %s",
    async (fragment) => {
      expect(await publishedDate(fragment)).toBeNull();
    },
  );
});

describe("official IMA response shapes", () => {
  test("incomplete pagination is an error rather than a false absence", async () => {
    spies.push(
      spyOn(fetchTarget, "fetch").mockImplementation(async () =>
        Response.json({
          code: 0,
          data: {
            addable_knowledge_base_list: [],
            knowledge_list: [],
            is_end: false,
          },
        }),
      ),
    );
    const c = { clientId: "test-client", apiKey: "test-key" };
    await expect(knowledgeBases(c)).rejects.toThrow("下一页");
    await expect(findExact(c, "kb", "Article.pdf")).rejects.toThrow("核验");
  });
  test("duplicate checking requires the documented result list", async () => {
    spies.push(
      spyOn(fetchTarget, "fetch").mockImplementation(async () =>
        Response.json({ code: 0, data: { is_repeated: false } }),
      ),
    );
    await expect(
      repeatedName(
        { clientId: "test-client", apiKey: "test-key" },
        "kb",
        "Article.pdf",
      ),
    ).rejects.toThrow("数据格式不受支持");
  });
  test("uses the documented list field and honors pagination", async () => {
    let page = 0;
    spies.push(
      spyOn(fetchTarget, "fetch").mockImplementation(async () =>
        Response.json({
          code: 0,
          data:
            page++ === 0
              ? {
                  addable_knowledge_base_list: [{ id: "one", name: "One" }],
                  next_cursor: "next",
                  is_end: false,
                }
              : {
                  addable_knowledge_base_list: [{ id: "two", name: "Two" }],
                  is_end: true,
                },
        }),
      ),
    );
    expect(
      await knowledgeBases({ clientId: "test-client", apiKey: "test-key" }),
    ).toHaveLength(2);
  });
  test("verification matches media identity and duplicate checks fail closed", async () => {
    spies.push(
      spyOn(fetchTarget, "fetch").mockImplementation(async (input) =>
        Response.json({
          code: 0,
          data: String(input).endsWith("get_knowledge_list")
            ? {
                knowledge_list: [{ media_id: "media", title: "Article.pdf" }],
                is_end: true,
              }
            : { results: [{ name: "Article.pdf", is_repeated: true }] },
        }),
      ),
    );
    const c = { clientId: "test-client", apiKey: "test-key" };
    expect(await findExact(c, "kb", "Other.pdf", "media")).toEqual({
      media_id: "media",
      title: "Article.pdf",
    });
    expect(await repeatedName(c, "kb", "Article.pdf")).toBe(true);
  });
});

test("metadata validates long-link identity without rejecting ordinary Chinese titles", async () => {
  const encoded = new TextEncoder().encode(
    '<meta property="og:title" content="实验验证新材料性能"><meta property="og:url" content="https://mp.weixin.qq.com/s?__biz=B&amp;mid=2&amp;idx=1&amp;sn=S"><span id="js_name">Publisher B</span>',
  );
  const valid = await metadata(
    encoded,
    "https://mp.weixin.qq.com/s?__biz=B&mid=2&idx=1&sn=S",
  );
  expect(valid.title).toBe("实验验证新材料性能");
  expect(
    metadata(encoded, "https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=S"),
  ).rejects.toThrow("与提交的链接不一致");
});
