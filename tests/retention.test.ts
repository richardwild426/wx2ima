import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLEANUP_BATCH_SIZE,
  cleanupExpiredPdfs,
  pdfExpiresAt,
} from "../src/retention";
import { publicJob } from "../src/store";
import type { Job } from "../src/types";
import { testEnv } from "./helpers";

const fixtures: ReturnType<typeof testEnv>[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
  for (const fixture of fixtures) fixture.db.close();
  fixtures.length = 0;
});
const now = new Date("2027-09-09T19:00:00Z");
const due = "2026-09-09 19:00:00";
function fixture(applyRetentionMigration = true) {
  const f = testEnv({ applyRetentionMigration });
  fixtures.push(f);
  f.db
    .prepare(
      "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials) VALUES ('account','Test','Test','synthetic','')",
    )
    .run();
  function add(
    id: string,
    stage = "complete",
    completed: string | null = due,
    media: string | null = `media-${id}`,
  ) {
    f.db
      .prepare(
        "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage,object_key,media_id,completed_at,file_name,article_key,kb_id) VALUES (?,'account',?,?,?, ?,?,?,? ,?,'kb')",
      )
      .run(
        id,
        `https://mp.weixin.qq.com/s/${id}`,
        id,
        stage,
        `pdf/account/${id}.pdf`,
        media,
        completed,
        `${id}.pdf`,
        `article-${id}`,
      );
    f.objects.set(`pdf/account/${id}.pdf`, new Uint8Array([1, 2, 3]));
  }
  function job(id: string) {
    return f.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Job;
  }
  return { ...f, add, job };
}

test("retention expires only verified terminal archives at the exact 365-day boundary", async () => {
  const f = fixture();
  f.add("due");
  f.add("duplicate", "duplicate");
  f.add("recent", "complete", "2026-09-09 19:00:01");
  f.add("old-upload-recent-verification", "complete", "2027-09-01 00:00:00");
  f.db
    .prepare(
      "UPDATE jobs SET created_at='2020-01-01 00:00:00' WHERE id='old-upload-recent-verification'",
    )
    .run();
  for (const stage of [
    "failed",
    "queued",
    "downloading",
    "validating",
    "saved",
    "uploading",
    "uploaded",
    "adding",
    "verifying",
  ])
    f.add(stage, stage);
  f.add("no-media", "complete", due, null);
  f.add("no-verification", "complete", null);
  f.db
    .prepare(
      "INSERT INTO imports VALUES ('account','article-due','kb','due','media-due','complete')",
    )
    .run();
  const before = f.job("due");
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 2 });
  expect(f.objects.has(before.object_key as string)).toBe(false);
  expect(f.objects.has(f.job("duplicate").object_key as string)).toBe(false);
  for (const id of [
    "recent",
    "old-upload-recent-verification",
    "failed",
    "queued",
    "downloading",
    "validating",
    "saved",
    "uploading",
    "uploaded",
    "adding",
    "verifying",
    "no-media",
    "no-verification",
  ] as const) {
    expect(f.objects.has(f.job(id).object_key as string)).toBe(true);
    expect(f.job(id).pdf_deleted_at).toBeNull();
  }
  expect(f.job("due")).toEqual({
    ...before,
    pdf_deleted_at: "2027-09-09 19:00:00",
  });
  expect(f.db.prepare("SELECT * FROM imports").all()).toHaveLength(1);
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 0 });
});

test("retention does not depend on account credentials or current IMA access", async () => {
  const f = fixture();
  f.add("deleted-account");
  f.db
    .prepare(
      "UPDATE profiles SET deleted_at='2027-01-01 00:00:00',credentials=''",
    )
    .run();
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 1 });
  expect(f.job("deleted-account").stage).toBe("complete");
});

test("R2 deletion errors preserve download state and do not prevent other eligible cleanup", async () => {
  const f = fixture();
  f.add("a");
  f.add("b");
  const original = f.env.PDFS.delete.bind(f.env.PDFS);
  const deletion = spyOn(f.env.PDFS, "delete").mockImplementation(
    async (key) => {
      if (key === "pdf/account/a.pdf")
        throw new Error("synthetic provider error");
      return original(key);
    },
  );
  spies.push(deletion);
  await expect(cleanupExpiredPdfs(f.env, now)).rejects.toThrow(
    "1 archive(s); 1 cleaned",
  );
  expect(f.job("a").pdf_deleted_at).toBeNull();
  expect(publicJob(f.job("a")).has_pdf).toBe(true);
  expect(f.objects.has("pdf/account/a.pdf")).toBe(true);
  expect(f.job("b").pdf_deleted_at).not.toBeNull();
  deletion.mockRestore();
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 1 });
});

test("a database failure after object deletion is reconciled by the next run", async () => {
  const f = fixture();
  f.add("a");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  const broken = spyOn(f.env.DB, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("UPDATE jobs SET pdf_deleted_at"))
      throw new Error("synthetic database failure");
    return prepare(sql);
  });
  spies.push(broken);
  await expect(cleanupExpiredPdfs(f.env, now)).rejects.toThrow();
  expect(f.objects.size).toBe(0);
  expect(f.job("a").pdf_deleted_at).toBeNull();
  broken.mockRestore();
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 1 });
  expect(f.job("a").pdf_deleted_at).not.toBeNull();
});

test("overlapping cleanup invocations are idempotent", async () => {
  const f = fixture();
  f.add("a");
  await Promise.all([
    cleanupExpiredPdfs(f.env, now),
    cleanupExpiredPdfs(f.env, now),
  ]);
  expect(f.objects.size).toBe(0);
  expect(f.job("a").pdf_deleted_at).not.toBeNull();
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 0 });
});

test("cleanup is bounded and the next run drains the remaining archives", async () => {
  const f = fixture();
  for (let i = 0; i < CLEANUP_BATCH_SIZE + 3; i++) f.add(`job-${i}`);
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({
    deleted: CLEANUP_BATCH_SIZE,
  });
  expect(f.objects.size).toBe(3);
  expect(await cleanupExpiredPdfs(f.env, now)).toEqual({ deleted: 3 });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: CLEANUP_BATCH_SIZE + 3,
  });
});

test("public archive status distinguishes expired backups from unsaved or pending ones", () => {
  const f = fixture();
  f.add("a");
  expect(publicJob(f.job("a"))).toMatchObject({
    has_pdf: true,
    pdf_deleted_at: null,
    pdf_expires_at: "2027-09-09T19:00:00.000Z",
  });
  f.db.prepare("UPDATE jobs SET pdf_deleted_at='2027-09-09 19:00:00'").run();
  expect(publicJob(f.job("a"))).toMatchObject({
    has_pdf: false,
    pdf_deleted_at: "2027-09-09 19:00:00",
  });
  f.add("pending", "failed", null);
  expect(publicJob(f.job("pending"))).toMatchObject({
    has_pdf: true,
    pdf_deleted_at: null,
    pdf_expires_at: null,
  });
  expect(pdfExpiresAt({ ...f.job("a"), completed_at: "invalid" })).toBeNull();
});

test("migration backfills only verified terminal jobs without deleting any archive", () => {
  const f = fixture(false);
  for (const [id, stage, media] of [
    ["a", "complete", "media-a"],
    ["b", "duplicate", "media-b"],
    ["c", "failed", "media-c"],
    ["d", "complete", null],
  ] as const) {
    f.db
      .prepare(
        "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage,media_id,updated_at,object_key) VALUES (?,'account',?,?,?,?, '2026-08-01 00:00:00',?)",
      )
      .run(
        id,
        `https://mp.weixin.qq.com/s/${id}`,
        id,
        stage,
        media,
        `pdf/account/${id}.pdf`,
      );
  }
  f.db.exec(
    readFileSync(
      new URL("../migrations/0004_pdf_retention.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(f.job("a").completed_at).toBe("2026-08-01 00:00:00");
  expect(f.job("b").completed_at).toBe("2026-08-01 00:00:00");
  expect(f.job("c").completed_at).toBeNull();
  expect(f.job("d").completed_at).toBeNull();
  expect(f.job("a").pdf_deleted_at).toBeNull();
  expect(f.job("a").object_key).toBe("pdf/account/a.pdf");
});
