import { afterEach, expect, spyOn, test } from "bun:test";
import {
  deferImport,
  dispatchQueue,
  enqueueArticles,
  queueSummary,
} from "../src/queue";
import type { Job } from "../src/types";
import { testEnv } from "./helpers";

const fixtures: ReturnType<typeof testEnv>[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
  for (const f of fixtures) f.db.close();
  fixtures.length = 0;
});
function fixture() {
  const f = testEnv();
  fixtures.push(f);
  f.db
    .prepare(
      "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials,inbox_id) VALUES ('account','Test','Test','synthetic','','inbox')",
    )
    .run();
  const created = spyOn(f.env.IMPORTS, "create");
  spies.push(created);
  const recover = spyOn(f.env.IMPORTS, "createBatch");
  spies.push(recover);
  const job = (id: string) =>
    f.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Job;
  return { ...f, created, recover, job };
}
const links = (n: number, offset = 0) =>
  Array.from(
    { length: n },
    (_, i) => `https://mp.weixin.qq.com/s/article-${i + offset}`,
  );

test("one hundred links persist without starting external work or rejecting at twenty", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(100));
  expect(jobs).toHaveLength(100);
  expect(f.created).not.toHaveBeenCalled();
  expect(await queueSummary(f.env, "account")).toEqual({
    queued: 100,
    running: 0,
  });
  await dispatchQueue(f.env);
  expect(f.created).toHaveBeenCalledTimes(1);
  expect(f.created.mock.calls[0]?.[0]?.params?.jobId).toBe(jobs[0]?.id);
  expect(await queueSummary(f.env, "account")).toEqual({
    queued: 99,
    running: 1,
  });
});
test("parallel submissions and dispatchers deduplicate links and reserve only one global slot", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    enqueueArticles(f.env, "account", links(25)),
    enqueueArticles(f.env, "account", links(25)),
  ]);
  expect(a.map((j) => j.id)).toEqual(b.map((j) => j.id));
  await Promise.all(Array.from({ length: 10 }, () => dispatchQueue(f.env)));
  expect(f.created).toHaveBeenCalledTimes(1);
  expect(await queueSummary(f.env, "account")).toEqual({
    queued: 24,
    running: 1,
  });
});
test("completion and terminal failure release the slot in original submission order", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(3));
  await dispatchQueue(f.env);
  f.db
    .prepare("UPDATE jobs SET stage='complete' WHERE id=?")
    .run(idAt(jobs, 0));
  await dispatchQueue(f.env);
  expect(f.created.mock.calls[1]?.[0]?.params?.jobId).toBe(jobs[1]?.id);
  f.db.prepare("UPDATE jobs SET stage='failed' WHERE id=?").run(idAt(jobs, 1));
  await dispatchQueue(f.env);
  expect(f.created.mock.calls[2]?.[0]?.params?.jobId).toBe(jobs[2]?.id);
});
test("lost create responses retain the original ID and recover idempotently", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(2));
  f.created.mockRejectedValue(new Error("Synthetic lost response"));
  await dispatchQueue(f.env);
  const reserved = f.job(idAt(jobs, 0)).workflow_id;
  expect(reserved).not.toBeNull();
  f.db
    .prepare("UPDATE jobs SET updated_at='2020-01-01 00:00:00' WHERE id=?")
    .run(idAt(jobs, 0));
  const get = spyOn(f.env.IMPORTS, "get").mockRejectedValue(
    new Error("Synthetic unavailable status"),
  );
  spies.push(get);
  await dispatchQueue(f.env);
  expect(f.recover).toHaveBeenCalledWith([
    { id: reserved, params: { jobId: idAt(jobs, 0) } },
  ]);
  expect(f.created).toHaveBeenCalledTimes(1);
  expect(f.job(idAt(jobs, 1)).workflow_id).toBeNull();
});
test("cron detects workflows killed before failure persistence and continues the queue", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(2));
  await dispatchQueue(f.env);
  f.db
    .prepare(
      "UPDATE jobs SET stage='downloading',updated_at='2020-01-01 00:00:00' WHERE id=?",
    )
    .run(idAt(jobs, 0));
  const get = spyOn(f.env.IMPORTS, "get").mockResolvedValue({
    status: async () => ({ status: "errored" }),
  } as never);
  spies.push(get);
  await dispatchQueue(f.env);
  expect(f.job(idAt(jobs, 0)).stage).toBe("failed");
  expect(f.created.mock.calls[1]?.[0]?.params?.jobId).toBe(jobs[1]?.id);
});
test("transient status failures never free a running slot", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(2));
  await dispatchQueue(f.env);
  f.db
    .prepare(
      "UPDATE jobs SET stage='uploading',updated_at='2020-01-01 00:00:00' WHERE id=?",
    )
    .run(idAt(jobs, 0));
  const get = spyOn(f.env.IMPORTS, "get").mockRejectedValue(
    new Error("Synthetic network error"),
  );
  spies.push(get);
  await dispatchQueue(f.env);
  expect(f.job(idAt(jobs, 0)).stage).toBe("uploading");
  expect(f.created).toHaveBeenCalledTimes(1);
  expect(f.recover).not.toHaveBeenCalled();
});
test("provider cooldown defers the current import and blocks all accounts until expiry", async () => {
  const f = fixture();
  const jobs = await enqueueArticles(f.env, "account", links(2));
  await dispatchQueue(f.env);
  await deferImport(f.env, idAt(jobs, 0), new Date(Date.now() + 3600000));
  expect(f.job(idAt(jobs, 0)).stage).toBe("queued");
  expect(f.job(idAt(jobs, 0)).workflow_id).toBeNull();
  await dispatchQueue(f.env);
  expect(f.created).toHaveBeenCalledTimes(1);
  f.db
    .prepare(
      "UPDATE import_queue_control SET cooldown_until='2000-01-01 00:00:00'",
    )
    .run();
  await dispatchQueue(f.env);
  expect(f.created).toHaveBeenCalledTimes(2);
  expect(f.created.mock.calls[1]?.[0]?.params?.jobId).toBe(jobs[0]?.id);
});
test("D1 rejection rolls back an entire chunk rather than partially accepting links", async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER reject_queue BEFORE INSERT ON jobs WHEN NEW.source_url LIKE '%article-2' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
  );
  await expect(enqueueArticles(f.env, "account", links(5))).rejects.toThrow();
  expect(await queueSummary(f.env, "account")).toEqual({
    queued: 0,
    running: 0,
  });
});

function idAt(jobs: Job[], index: number) {
  const job = jobs[index];
  if (!job) throw new Error("Missing queued fixture");
  return job.id;
}
