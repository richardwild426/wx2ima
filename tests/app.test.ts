import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { cleanupExpiredPdfs } from "../src/retention";
import {
  createSession,
  decrypt,
  digest,
  encrypt,
  passwordHash,
} from "../src/security";
import type { Credentials, Job, KnowledgeBase, Profile } from "../src/types";
import { fetchTarget, testEnv } from "./helpers";

mock.module("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
const { default: app, handle } = await import("../src/index");
const { ImportWorkflow } = await import("../src/workflow");
const spies: ReturnType<typeof spyOn>[] = [];
const databases: ReturnType<typeof testEnv>["db"][] = [];
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
  for (const db of databases) db.close();
  databases.length = 0;
});
test("all data and downloads require the shared session", async () => {
  const { env } = testEnv();
  for (const path of [
    "/api/profiles",
    "/api/jobs?profile=anything",
    "/api/jobs/abc/pdf",
  ])
    expect(
      handle(new Request(`${env.APP_ORIGIN}${path}`), env),
    ).rejects.toThrow("请先登录");
});
test("account API stores encrypted keys and returns only a fingerprint", async () => {
  const { env, db } = testEnv();
  env.ACCESS_PASSWORD_HASH = await passwordHash("test password");
  const cookie = await createSession(env);
  spies.push(
    spyOn(fetchTarget, "fetch").mockResolvedValue(
      Response.json({
        code: 0,
        data: {
          addable_knowledge_base_list: [{ id: "kb", name: "Library" }],
          is_end: true,
        },
      }),
    ),
  );
  const req = new Request(`${env.APP_ORIGIN}/api/profiles`, {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({
      name: "Work",
      ownerName: "Alice",
      clientId: "synthetic-client",
      apiKey: "synthetic-private-key",
    }),
  });
  const response = await handle(req, env);
  const body = await response.text();
  expect(response.status).toBe(201);
  expect(body).not.toContain("synthetic-private-key");
  expect(body).not.toContain("synthetic-client");
  expect(body).toContain("Alice");
  const saved = db.prepare("SELECT credentials FROM profiles").get() as {
    credentials: string;
  };
  expect(saved.credentials).not.toContain("synthetic-private-key");
});
async function workflowFixture() {
  const { env, db, objects } = testEnv();
  const profileId = "account";
  const cred = await encrypt(
    { clientId: "synthetic-client", apiKey: "synthetic-key" },
    env.ENCRYPTION_KEY,
    profileId,
  );
  db.prepare(
    "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials,inbox_id,inbox_name) VALUES (?,?,?,?,?,?,?)",
  ).run(profileId, "Work", "Alice", "fingerprint", cred, "inbox", "Unsorted");
  db.prepare(
    "INSERT INTO jobs(id,profile_id,source_url,url_hash) VALUES (?,?,?,?)",
  ).run("job", profileId, "https://mp.weixin.qq.com/s/abc", "hash");
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const pdfBytes = await pdf.save();
  let creates = 0,
    adds = 0,
    putFails = false,
    addAmbiguous = false,
    visible = true;
  const entries: { media_id: string; title: string }[] = [];
  const occupiedNames = new Set<string>();
  let publicationDate: string | null = "2020年6月18日 09:30";
  let pdfDownloads = 0;
  let conversions = 0;
  let throttledEndpoint: string | null = null;
  spies.push(
    spyOn(fetchTarget, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (throttledEndpoint && url.endsWith(throttledEndpoint))
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "3600" },
        });
      const parsed =
        init?.body && typeof init.body === "string"
          ? JSON.parse(init.body)
          : {};
      if (url === "https://changfengbox.top/api/mcp") {
        if (parsed.method === "tools/call") conversions++;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: parsed.id,
            result:
              parsed.method === "initialize"
                ? { protocolVersion: "2025-06-18" }
                : parsed.method === "notifications/initialized"
                  ? {}
                  : {
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
          },
          { headers: { "Mcp-Session-Id": "test" } },
        );
      }
      if (url === "https://changfengbox.top/a.html")
        return new Response(
          `<meta property="og:title" content="An article"><meta property="og:url" content="https://mp.weixin.qq.com/s/abc"><span id="js_name">Publisher</span>${publicationDate ? `<em id="publish_time">${publicationDate}</em>` : ""}`,
        );
      if (url === "https://changfengbox.top/a.pdf") {
        pdfDownloads++;
        return new Response(new Uint8Array(pdfBytes).buffer);
      }
      if (url.includes(".myqcloud.com")) {
        const uploaded = await new Response(
          init?.body as BodyInit,
        ).arrayBuffer();
        expect(uploaded.byteLength).toBe(pdfBytes.length);
        expect(new Headers(init?.headers).get("Content-Length")).toBe(
          String(pdfBytes.length),
        );
        return new Response("", { status: putFails ? 503 : 200 });
      }
      if (url.endsWith("get_addable_knowledge_base_list"))
        return Response.json({
          code: 0,
          data: {
            addable_knowledge_base_list: [
              { id: "inbox", name: "Unsorted" },
              { id: "mapped", name: "Mapped library" },
            ],
            is_end: true,
          },
        });
      if (url.endsWith("get_knowledge_list"))
        return Response.json({
          code: 0,
          data: { knowledge_list: visible ? entries : [], is_end: true },
        });
      if (url.endsWith("check_repeated_names"))
        return Response.json({
          code: 0,
          data: {
            results: [
              {
                name: parsed.params[0].name,
                is_repeated: occupiedNames.has(parsed.params[0].name),
              },
            ],
          },
        });
      if (url.endsWith("create_media")) {
        creates++;
        return Response.json({
          code: 0,
          data: {
            media_id: "media-1",
            cos_credential: {
              secret_id: "test",
              secret_key: "test",
              token: "test",
              bucket_name: "test-123",
              region: "ap-guangzhou",
              cos_key: "folder/file.pdf",
              start_time: 1,
              expired_time: 9999999999,
            },
          },
        });
      }
      if (url.endsWith("add_knowledge")) {
        adds++;
        expect(parsed.title).toBe(parsed.file_info.file_name);
        expect(parsed.title).toEndWith(".pdf");
        entries.push({ media_id: "media-1", title: parsed.title });
        if (addAmbiguous) throw new TypeError("Simulated lost response");
        return Response.json({ code: 0, data: { media_id: "media-1" } });
      }
      throw new Error(`Unexpected fixture endpoint ${url}`);
    }),
  );
  const workflow = new ImportWorkflow({} as ExecutionContext, env);
  const step = {
    async do(_name: unknown, ...args: unknown[]) {
      const callback = args[args.length - 1] as () => Promise<unknown>;
      return callback();
    },
  };
  async function run(jobId = "job") {
    return workflow.run({ payload: { jobId } } as never, step as never);
  }
  return {
    env,
    db,
    objects,
    occupiedNames,
    sourceCounts: () => ({ pdfDownloads, conversions }),
    throttle: (endpoint: string | null) => {
      throttledEndpoint = endpoint;
    },
    setPublicationDate: (value: string | null) => {
      publicationDate = value;
    },
    run,
    counts: () => ({ creates, adds }),
    setPutFails: (value: boolean) => {
      putFails = value;
    },
    setAmbiguous: (value: boolean) => {
      addAmbiguous = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}
test("full import uses Unsorted, archives PDF and verifies the IMA entry", async () => {
  const f = await workflowFixture();
  await f.run();
  const job = f.db.prepare("SELECT * FROM jobs WHERE id=?").get("job") as {
    stage: string;
    used_inbox: number;
    file_name: string;
  };
  expect(job.stage).toBe("complete");
  expect(job.used_inbox).toBe(1);
  expect(
    (f.db.prepare("SELECT completed_at FROM jobs WHERE id='job'").get() as Job)
      .completed_at,
  ).not.toBeNull();
  expect(job.file_name).toBe("2020-06-18_An article.pdf");
  expect(f.objects.size).toBe(1);
  expect(f.counts()).toEqual({ creates: 1, adds: 1 });
  await f.run();
  expect(f.counts()).toEqual({ creates: 1, adds: 1 });
});
test("filename collisions use readable numbers and retries do not stack suffixes", async () => {
  const f = await workflowFixture();
  const base = "2020-06-18_An article";
  f.occupiedNames.add(`${base}.pdf`);
  f.db
    .prepare(
      "INSERT INTO jobs(id,profile_id,source_url,url_hash,kb_id,file_name,stage) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      "other-job",
      "account",
      "https://mp.weixin.qq.com/s/other",
      "other-hash",
      "inbox",
      `${base}（2）.pdf`,
      "uploading",
    );
  f.setPutFails(true);
  await expect(f.run()).rejects.toThrow();
  expect(
    (
      f.db.prepare("SELECT file_name FROM jobs WHERE id='job'").get() as {
        file_name: string;
      }
    ).file_name,
  ).toBe(`${base}（3）.pdf`);
  f.setPutFails(false);
  f.setPublicationDate("2026年9月9日");
  await f.run();
  const saved = f.db
    .prepare("SELECT file_name,stage FROM jobs WHERE id='job'")
    .get();
  expect(saved).toEqual({ file_name: `${base}（3）.pdf`, stage: "complete" });
  expect(f.objects.size).toBe(1);
  expect(f.counts().adds).toBe(1);
});
test("publisher mappings are scoped to the selected IMA account", async () => {
  const f = await workflowFixture();
  f.db
    .prepare("INSERT INTO mappings VALUES (?,?,?,?,?)")
    .run("account", "name:Publisher", "Publisher", "mapped", "Mapped library");
  await f.run();
  const row = f.db.prepare("SELECT kb_id,used_inbox FROM jobs").get() as {
    kb_id: string;
    used_inbox: number;
  };
  expect(row).toEqual({ kb_id: "mapped", used_inbox: 0 });
});
test("failed object upload never adds an IMA entry and retry reuses the archive", async () => {
  const f = await workflowFixture();
  f.setPutFails(true);
  expect(f.run()).rejects.toThrow();
  expect(f.counts().adds).toBe(0);
  expect(f.objects.size).toBe(1);
  f.setPutFails(false);
  await f.run();
  expect(f.counts().adds).toBe(1);
  expect(f.objects.size).toBe(1);
});
test("an ambiguous IMA write is reconciled without a second add", async () => {
  const f = await workflowFixture();
  f.setAmbiguous(true);
  expect(f.run()).rejects.toThrow();
  expect(f.counts().adds).toBe(1);
  f.setAmbiguous(false);
  f.setVisible(false);
  expect(f.run()).rejects.toThrow();
  expect(f.counts().adds).toBe(1);
  f.setVisible(true);
  await f.run();
  expect(f.counts()).toEqual({ creates: 1, adds: 1 });
});

test("simultaneous connections of the same Client ID preserve decryptable credentials", async () => {
  const { env, db } = testEnv();
  env.ACCESS_PASSWORD_HASH = await passwordHash("test password");
  const cookie = await createSession(env);
  spies.push(
    spyOn(fetchTarget, "fetch").mockImplementation(async () =>
      Response.json({
        code: 0,
        data: {
          addable_knowledge_base_list: [{ id: "kb", name: "Library" }],
          is_end: true,
        },
      }),
    ),
  );
  const request = (apiKey: string) =>
    new Request(`${env.APP_ORIGIN}/api/profiles`, {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        name: "Work",
        ownerName: "Alice",
        clientId: "shared-synthetic-client",
        apiKey,
      }),
    });
  await Promise.all([
    handle(request("synthetic-one"), env),
    handle(request("synthetic-two"), env),
  ]);
  const records = db.prepare("SELECT id,credentials FROM profiles").all() as {
    id: string;
    credentials: string;
  }[];
  expect(records).toHaveLength(1);
  const p = records[0];
  if (!p) throw new Error("Missing profile");
  const { decrypt } = await import("../src/security");
  const decrypted = await decrypt<{ apiKey: string }>(
    p.credentials,
    env.ENCRYPTION_KEY,
    p.id,
  );
  expect(["synthetic-one", "synthetic-two"]).toContain(decrypted.apiKey);
});

const profileA = "a1";
const profileB = "b2";
const completedJob = "a101";
const failedJob = "a102";
const duplicateJob = "a103";
const activeJob = "a104";
const originalCredentials = {
  clientId: "synthetic-profile-a-client",
  apiKey: "synthetic-profile-a-original-key",
};
const otherCredentials = {
  clientId: "synthetic-profile-b-client",
  apiKey: "synthetic-profile-b-private-key",
};
const replacementKey = "synthetic-profile-a-replacement-key";
const editedMetadata = { name: "Renamed account", ownerName: "New owner" };
const rotatedProfile = {
  ...editedMetadata,
  ...originalCredentials,
  apiKey: replacementKey,
};

/** Exercise the HTTP error boundary so failures cannot hide credential leaks in thrown errors. */
async function profileFixture() {
  const { env, db, objects } = testEnv();
  databases.push(db);
  env.ACCESS_PASSWORD_HASH = "synthetic-session-password-hash";
  const cookie = await createSession(env);
  const remote = spyOn(fetchTarget, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected external request in profile test");
  });
  const startWorkflow = spyOn(env.IMPORTS, "create");
  spies.push(remote, startWorkflow);
  for (const [id, c] of [
    [profileA, originalCredentials],
    [profileB, otherCredentials],
  ] as const) {
    db.prepare(
      "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials,inbox_id,inbox_name,kb_count,verified_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      `Account ${id}`,
      `Owner ${id}`,
      await digest(c.clientId),
      await encrypt(c, env.ENCRYPTION_KEY, id),
      `inbox-${id}`,
      `Inbox ${id}`,
      1,
      "2020-01-01 00:00:00",
    );
    db.prepare("INSERT INTO mappings VALUES (?,?,?,?,?)").run(
      id,
      "name:Publisher",
      "Publisher",
      `mapped-${id}`,
      `Mapped ${id}`,
    );
  }
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const pdfBytes = await pdf.save();
  const objectKey = `pdf/${profileA}/${completedJob}.pdf`;
  objects.set(objectKey, pdfBytes);
  db.prepare(
    "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage,article_key,account_key,file_name,object_key,file_size,kb_id,media_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    completedJob,
    profileA,
    "https://mp.weixin.qq.com/s/history",
    "history-hash",
    "complete",
    "article-history",
    "name:Publisher",
    "History.pdf",
    objectKey,
    pdfBytes.length,
    `mapped-${profileA}`,
    "existing-media",
  );
  for (const [id, owner, stage] of [
    [failedJob, profileA, "failed"],
    [duplicateJob, profileA, "duplicate"],
    ["b201", profileB, "uploading"],
  ] as const) {
    db.prepare(
      "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage) VALUES (?,?,?,?,?)",
    ).run(id, owner, `https://mp.weixin.qq.com/s/${id}`, `hash-${id}`, stage);
  }
  for (const [id, job] of [
    [profileA, completedJob],
    [profileB, "b201"],
  ] as const) {
    db.prepare(
      "INSERT INTO imports(profile_id,article_key,kb_id,job_id,media_id,status) VALUES (?,?,?,?,?,?)",
    ).run(
      id,
      "article-history",
      `mapped-${id}`,
      job,
      `media-${id}`,
      "complete",
    );
  }
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.fetch(
      new Request(`${env.APP_ORIGIN}${path}`, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          "Content-Type": "application/json",
          Cookie: cookie,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  }
  function profile(id = profileA) {
    return db
      .prepare("SELECT * FROM profiles WHERE id=?")
      .get(id) as Profile & { deleted_at: string | null };
  }
  function snapshot() {
    return {
      profiles: db
        .prepare<Profile, []>("SELECT * FROM profiles ORDER BY id")
        .all(),
      mappings: db
        .prepare("SELECT * FROM mappings ORDER BY profile_id,account_key")
        .all(),
      jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
      imports: db
        .prepare("SELECT * FROM imports ORDER BY profile_id,article_key,kb_id")
        .all(),
      objects: [...objects.entries()].map(([key, bytes]) => [key, [...bytes]]),
    };
  }
  function allowVerification(
    c: Credentials = { ...originalCredentials, apiKey: replacementKey },
    bases: KnowledgeBase[] = [
      { id: `inbox-${profileA}`, name: "Inbox A" },
      { id: `mapped-${profileA}`, name: "Mapped A" },
    ],
  ) {
    const verify: typeof fetchTarget.fetch = async (input, init) => {
      expect(String(input)).toBe(
        "https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list",
      );
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("ima-openapi-clientid")).toBe(c.clientId);
      expect(headers.get("ima-openapi-apikey")).toBe(c.apiKey);
      return Response.json({
        code: 0,
        data: {
          addable_knowledge_base_list: bases,
          is_end: true,
        },
      });
    };
    remote.mockImplementation(verify);
    return verify;
  }
  function addActiveJob(stage: string) {
    db.prepare(
      "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage) VALUES (?,?,?,?,?)",
    ).run(
      activeJob,
      profileA,
      "https://mp.weixin.qq.com/s/active",
      "active-hash",
      stage,
    );
  }
  return {
    env,
    db,
    objects,
    remote,
    startWorkflow,
    request,
    profile,
    snapshot,
    allowVerification,
    addActiveJob,
    pdfBytes,
  };
}

type PublicProfile = ReturnType<typeof import("../src/store").publicProfile>;
type PublicJob = ReturnType<typeof import("../src/store").publicJob>;
async function expectPrivateResponse<T = { profile: PublicProfile }>(
  response: Response,
  ciphertext?: string,
) {
  const text = await response.clone().text();
  for (const secret of [
    originalCredentials.clientId,
    originalCredentials.apiKey,
    otherCredentials.clientId,
    otherCredentials.apiKey,
    replacementKey,
    ciphertext,
  ].filter(Boolean)) {
    expect(text).not.toContain(secret as string);
  }
  expect(text).not.toContain('"credentials"');
  expect(text).not.toContain('"apiKey"');
  expect(text).not.toContain('"clientId"');
  return response.json() as Promise<T>;
}

function expectStoredHistory(
  f: Awaited<ReturnType<typeof profileFixture>>,
  before: ReturnType<typeof f.snapshot>,
) {
  const after = f.snapshot();
  expect(after.jobs).toEqual(before.jobs);
  expect(after.imports).toEqual(before.imports);
  expect(after.objects).toEqual(before.objects);
  expect(f.profile(profileB)).toEqual(
    before.profiles.find((p) => p.id === profileB) as Profile,
  );
  expect(
    after.mappings.filter(
      (m) => (m as { profile_id: string }).profile_id === profileB,
    ),
  ).toEqual(
    before.mappings.filter(
      (m) => (m as { profile_id: string }).profile_id === profileB,
    ),
  );
  expect(f.startWorkflow).not.toHaveBeenCalled();
}

describe("profile mutation API", () => {
  test.each([
    ["omitted", {}],
    ["empty", { clientId: "", apiKey: "" }],
  ])(
    "metadata edits with %s credentials preserve account state without IMA",
    async (_label, fields) => {
      const f = await profileFixture();
      f.addActiveJob("uploading");
      const before = f.snapshot();
      const original = f.profile();
      const response = await f.request(`/api/profiles/${profileA}`, "PUT", {
        ...editedMetadata,
        ...fields,
      });
      expect(response.status).toBe(200);
      const body = await expectPrivateResponse(response, original.credentials);
      expect(body.profile).toMatchObject({
        id: profileA,
        name: editedMetadata.name,
        owner_name: editedMetadata.ownerName,
        deleted_at: null,
      });
      expect(f.profile()).toEqual({
        ...original,
        name: editedMetadata.name,
        owner_name: editedMetadata.ownerName,
      });
      expect(f.snapshot().mappings).toEqual(before.mappings);
      expectStoredHistory(f, before);
      expect(f.remote).not.toHaveBeenCalled();
    },
  );

  test("metadata editing does not need decryptable saved credentials or an encryption key", async () => {
    const f = await profileFixture();
    f.db.prepare("UPDATE profiles SET credentials='' WHERE id=?").run(profileA);
    f.env.ENCRYPTION_KEY = "";
    const original = f.profile();
    const response = await f.request(
      `/api/profiles/${profileA}`,
      "PUT",
      editedMetadata,
    );
    expect(response.status).toBe(200);
    expect(f.profile()).toEqual({
      ...original,
      name: editedMetadata.name,
      owner_name: editedMetadata.ownerName,
    });
    expect(f.remote).not.toHaveBeenCalled();
  });

  test.each([
    ["client only", { clientId: originalCredentials.clientId }],
    ["key only", { apiKey: replacementKey }],
    ["blank key", { clientId: originalCredentials.clientId, apiKey: "" }],
    ["blank client", { clientId: "", apiKey: replacementKey }],
    ["whitespace credentials", { clientId: "  ", apiKey: "  " }],
  ])(
    "rejects %s without touching metadata, credentials or records",
    async (_label, fields) => {
      const f = await profileFixture();
      const before = f.snapshot();
      const response = await f.request(`/api/profiles/${profileA}`, "PUT", {
        ...editedMetadata,
        ...fields,
      });
      expect(response.status).toBe(400);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(before);
      expect(f.remote).not.toHaveBeenCalled();
    },
  );

  test.each([
    { name: "Updated" },
    { ownerName: "Updated" },
    { name: "", ownerName: "Updated" },
    { name: "Updated", ownerName: "  " },
    { name: "x".repeat(81), ownerName: "Updated" },
    { name: "Updated", ownerName: "x".repeat(81) },
  ])("requires valid full metadata: %j", async (body) => {
    const f = await profileFixture();
    const before = f.snapshot();
    const response = await f.request(`/api/profiles/${profileA}`, "PUT", body);
    expect(response.status).toBe(400);
    expect(f.snapshot()).toEqual(before);
    expect(f.remote).not.toHaveBeenCalled();
  });

  test("rotates verified credentials for the same identity and keeps rules and history", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    const original = f.profile();
    f.allowVerification();
    const response = await f.request(
      `/api/profiles/${profileA}`,
      "PUT",
      rotatedProfile,
    );
    expect(response.status).toBe(200);
    const body = await expectPrivateResponse(response, original.credentials);
    expect(body.profile).toMatchObject({
      id: profileA,
      name: editedMetadata.name,
      owner_name: editedMetadata.ownerName,
      kb_count: 2,
      deleted_at: null,
    });
    const saved = f.profile();
    expect(saved.credentials).not.toBe(original.credentials);
    expect(saved.credentials).not.toContain(replacementKey);
    expect(
      await decrypt<Credentials>(
        saved.credentials,
        f.env.ENCRYPTION_KEY,
        profileA,
      ),
    ).toEqual({ ...originalCredentials, apiKey: replacementKey });
    await expect(
      decrypt(saved.credentials, f.env.ENCRYPTION_KEY, profileB),
    ).rejects.toThrow();
    expect(saved.client_fingerprint).toBe(original.client_fingerprint);
    expect(saved.inbox_id).toBe(original.inbox_id);
    expect(saved.inbox_name).toBe(original.inbox_name);
    expect(saved.verified_at).not.toBe(original.verified_at);
    expect(f.snapshot().mappings).toEqual(before.mappings);
    expectStoredHistory(f, before);
    expect(f.remote).toHaveBeenCalledTimes(1);
    const listing = await f.request("/api/profiles");
    expect(listing.status).toBe(200);
    await expectPrivateResponse(listing, saved.credentials);
  });

  test.each([otherCredentials.clientId, "synthetic-unconnected-client"])(
    "cannot change the account identity to %s",
    async (clientId) => {
      const f = await profileFixture();
      const before = f.snapshot();
      f.allowVerification({ clientId, apiKey: replacementKey });
      const response = await f.request(`/api/profiles/${profileA}`, "PUT", {
        ...rotatedProfile,
        clientId,
      });
      expect(response.status).toBe(409);
      expect(await response.clone().text()).not.toContain(clientId);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(before);
    },
  );

  test.each(["denied", "network", "business", "malformed"])(
    "failed %s verification leaves every original record intact and hides secrets",
    async (failure) => {
      const f = await profileFixture();
      const before = f.snapshot();
      f.remote.mockImplementation(async () => {
        const message = `凭据验证失败 ${originalCredentials.clientId} ${replacementKey} https://example.test/private?signature=synthetic-signature`;
        if (failure === "network") throw new Error(message);
        if (failure === "denied") return new Response(message, { status: 401 });
        if (failure === "malformed") return new Response(message);
        return Response.json({ code: 1234, msg: message });
      });
      const response = await f.request(
        `/api/profiles/${profileA}`,
        "PUT",
        rotatedProfile,
      );
      expect(response.status).toBe(failure === "business" ? 422 : 502);
      expect(await response.clone().text()).not.toContain(
        "synthetic-signature",
      );
      await expectPrivateResponse(response, f.profile().credentials);
      expect(f.snapshot()).toEqual(before);
      expect(f.remote).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    "queued",
    "downloading",
    "validating",
    "saved",
    "uploading",
    "uploaded",
    "adding",
    "verifying",
  ])(
    "%s jobs prevent rotation, reconnection and deletion but allow metadata edits",
    async (stage) => {
      const f = await profileFixture();
      f.addActiveJob(stage);
      f.allowVerification();
      const before = f.snapshot();
      for (const [path, method, body] of [
        [`/api/profiles/${profileA}`, "PUT", rotatedProfile],
        ["/api/profiles", "POST", rotatedProfile],
        [`/api/profiles/${profileA}`, "DELETE", {}],
      ] as const) {
        const response = await f.request(path, method, body);
        expect(response.status).toBe(409);
        await expectPrivateResponse(response);
        expect(f.snapshot()).toEqual(before);
      }
      const original = f.profile();
      expect(
        (await f.request(`/api/profiles/${profileA}`, "PUT", editedMetadata))
          .status,
      ).toBe(200);
      expect(f.profile()).toEqual({
        ...original,
        name: editedMetadata.name,
        owner_name: editedMetadata.ownerName,
      });
      expect(f.remote).toHaveBeenCalledTimes(2);
      expect(f.startWorkflow).not.toHaveBeenCalled();
    },
  );

  test.each(["PUT", "DELETE"])(
    "%s requires a session and same-origin JSON before any mutation",
    async (method) => {
      const f = await profileFixture();
      const before = f.snapshot();
      for (const [headers, status] of [
        [{ Cookie: "" }, 401],
        [{ Origin: "https://elsewhere.test" }, 403],
        [{ "Content-Type": "text/plain" }, 415],
      ] as const) {
        const response = await f.request(
          `/api/profiles/${profileA}`,
          method,
          method === "PUT" ? editedMetadata : {},
          headers,
        );
        expect(response.status).toBe(status);
        expect(f.snapshot()).toEqual(before);
      }
      expect(f.remote).not.toHaveBeenCalled();
    },
  );

  test("missing profile IDs fail without mutating another account", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    for (const method of ["PUT", "DELETE"]) {
      const response = await f.request(
        "/api/profiles/deadbeef",
        method,
        method === "PUT" ? rotatedProfile : {},
      );
      expect(response.status).toBe(404);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(before);
    }
    expect(f.remote).not.toHaveBeenCalled();
  });
});

describe("profile deletion and restoration", () => {
  test("deletion clears local connection data while preserving history, archives and other accounts", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    const original = f.profile();
    const response = await f.request(`/api/profiles/${profileA}`, "DELETE", {});
    expect(response.status).toBe(200);
    await expectPrivateResponse(response, original.credentials);
    const deleted = f.profile();
    expect(deleted.id).toBe(original.id);
    expect(deleted.client_fingerprint).toBe(original.client_fingerprint);
    expect(deleted.deleted_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(deleted.deleted_at as string))).toBe(false);
    expect(deleted.credentials).toBe("");
    expect(deleted.inbox_id).toBeNull();
    expect(deleted.inbox_name).toBeNull();
    expect(
      f.db.prepare("SELECT * FROM mappings WHERE profile_id=?").all(profileA),
    ).toEqual([]);
    expectStoredHistory(f, before);
    expect(f.remote).not.toHaveBeenCalled();
  });

  test("deleted accounts with history remain listed and their jobs and PDFs are readable", async () => {
    const f = await profileFixture();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(200);
    const response = await f.request("/api/profiles");
    expect(response.status).toBe(200);
    const body = await expectPrivateResponse<{ profiles: PublicProfile[] }>(
      response,
    );
    expect(body.profiles).toHaveLength(2);
    expect(body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: profileA,
          deleted_at: f.profile().deleted_at,
        }),
        expect.objectContaining({ id: profileB, deleted_at: null }),
      ]),
    );
    const history = await f.request(`/api/jobs?profile=${profileA}`);
    expect(history.status).toBe(200);
    const jobs = ((await history.json()) as { jobs: PublicJob[] }).jobs;
    expect(jobs.map((job) => job.id).sort()).toEqual([
      completedJob,
      failedJob,
      duplicateJob,
    ]);
    expect(jobs.every((job) => job.profile_id === profileA)).toBe(true);
    const detail = await f.request(`/api/jobs/${completedJob}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { job: PublicJob }).job).toMatchObject({
      id: completedJob,
      has_pdf: true,
      stage: "complete",
    });
    const download = await f.request(`/api/jobs/${completedJob}/pdf`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array(f.pdfBytes),
    );
    const unauthenticated = await f.request(
      `/api/jobs/${completedJob}/pdf`,
      "GET",
      undefined,
      { Cookie: "" },
    );
    expect(unauthenticated.status).toBe(401);
    expect(f.remote).not.toHaveBeenCalled();
  });

  test("deleted profiles without jobs are hidden but can reconnect with the same ID", async () => {
    const f = await profileFixture();
    const emptyId = "c3";
    const emptyCredentials = {
      clientId: "synthetic-empty-client",
      apiKey: "synthetic-empty-key",
    };
    f.db
      .prepare(
        "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials) VALUES (?,?,?,?,?)",
      )
      .run(
        emptyId,
        "Empty",
        "Owner",
        await digest(emptyCredentials.clientId),
        await encrypt(emptyCredentials, f.env.ENCRYPTION_KEY, emptyId),
      );
    expect(
      (await f.request(`/api/profiles/${emptyId}`, "DELETE", {})).status,
    ).toBe(200);
    const list = await f.request("/api/profiles");
    const ids = (
      (await list.json()) as { profiles: PublicProfile[] }
    ).profiles.map((p) => p.id);
    expect(ids.sort()).toEqual([profileA, profileB]);
    expect(f.profile(emptyId).deleted_at).toEqual(expect.any(String));
    f.allowVerification(emptyCredentials);
    const response = await f.request("/api/profiles", "POST", {
      ...editedMetadata,
      ...emptyCredentials,
    });
    expect(response.status).toBe(201);
    expect(
      ((await response.json()) as { profile: PublicProfile }).profile.id,
    ).toBe(emptyId);
    expect(f.profile(emptyId).deleted_at).toBeNull();
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM profiles").get(),
    ).toEqual({ count: 3 });
  });

  test("deleted accounts reject all new work and settings mutations without changing retained state", async () => {
    const f = await profileFixture();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(200);
    const before = f.snapshot();
    for (const [path, method, body] of [
      [
        "/api/jobs",
        "POST",
        { profileId: profileA, urls: ["https://mp.weixin.qq.com/s/new"] },
      ],
      [`/api/jobs/${failedJob}/retry`, "POST", {}],
      [
        `/api/profiles/${profileA}/settings`,
        "PUT",
        { inboxId: `inbox-${profileA}` },
      ],
      [
        `/api/profiles/${profileA}/mappings`,
        "POST",
        { accountName: "Publisher", kbId: `mapped-${profileA}` },
      ],
      [
        `/api/profiles/${profileA}/mappings`,
        "DELETE",
        { accountKey: "name:Publisher" },
      ],
      [`/api/profiles/${profileA}`, "PUT", editedMetadata],
      [`/api/profiles/${profileA}`, "PUT", rotatedProfile],
      [`/api/profiles/${profileA}`, "DELETE", {}],
    ] as const) {
      const response = await f.request(path, method, body);
      expect([404, 409]).toContain(response.status);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(before);
    }
    expect(f.remote).not.toHaveBeenCalled();
    expect(f.startWorkflow).not.toHaveBeenCalled();
  });

  test("a failed reconnection cannot restore a deleted account or alter retained records", async () => {
    const f = await profileFixture();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(200);
    const before = f.snapshot();
    f.remote.mockResolvedValue(
      new Response("Credentials denied", { status: 401 }),
    );
    const response = await f.request("/api/profiles", "POST", rotatedProfile);
    expect(response.status).toBe(502);
    await expectPrivateResponse(response);
    expect(f.snapshot()).toEqual(before);
    expect(f.remote).toHaveBeenCalledTimes(1);
  });

  test("reconnection restores the same identity and preserves deduplication across deletion", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(200);
    f.allowVerification();
    const response = await f.request("/api/profiles", "POST", rotatedProfile);
    expect(response.status).toBe(201);
    const body = await expectPrivateResponse(response);
    expect(body.profile).toMatchObject({
      id: profileA,
      name: editedMetadata.name,
      owner_name: editedMetadata.ownerName,
      deleted_at: null,
    });
    const restored = f.profile();
    expect(restored.deleted_at).toBeNull();
    expect(restored.inbox_id).toBeNull();
    expect(restored.inbox_name).toBeNull();
    expect(
      await decrypt<Credentials>(
        restored.credentials,
        f.env.ENCRYPTION_KEY,
        profileA,
      ),
    ).toEqual({ ...originalCredentials, apiKey: replacementKey });
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM profiles").get(),
    ).toEqual({ count: 2 });
    expect(
      f.db.prepare("SELECT * FROM mappings WHERE profile_id=?").all(profileA),
    ).toEqual([]);
    expectStoredHistory(f, before);
    expect(
      (await f.request(`/api/profiles/${profileA}`, "PUT", editedMetadata))
        .status,
    ).toBe(200);
    expect(
      (
        await f.request(`/api/profiles/${profileA}/settings`, "PUT", {
          inboxId: `inbox-${profileA}`,
        })
      ).status,
    ).toBe(200);
    const retried = await f.request(`/api/jobs/${failedJob}/retry`, "POST", {});
    expect(retried.status).toBe(202);
    expect(f.startWorkflow).not.toHaveBeenCalled();
    expect(((await retried.json()) as { job: PublicJob }).job.stage).toBe(
      "queued",
    );
  });

  test("failure clearing mappings rolls back credential removal and the deletion marker", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    f.db.exec(`CREATE TRIGGER reject_mapping_delete BEFORE DELETE ON mappings
      WHEN OLD.profile_id = '${profileA}' BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END`);
    const response = await f.request(`/api/profiles/${profileA}`, "DELETE", {});
    expect(response.status).toBe(500);
    await expectPrivateResponse(response, f.profile().credentials);
    expect(f.snapshot()).toEqual(before);
    expect(f.remote).not.toHaveBeenCalled();
  });

  test("failure updating a profile rolls back mapping deletion as well", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    f.db.exec(`CREATE TRIGGER reject_profile_delete BEFORE UPDATE ON profiles
      WHEN OLD.id = '${profileA}' BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END`);
    const response = await f.request(`/api/profiles/${profileA}`, "DELETE", {});
    expect(response.status).toBe(500);
    await expectPrivateResponse(response, f.profile().credentials);
    expect(f.snapshot()).toEqual(before);
    expect(f.remote).not.toHaveBeenCalled();
  });

  test("the D1 fixture enforces foreign keys and rolls back a failed batch in order", async () => {
    const f = await profileFixture();
    expect(f.db.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    const before = f.snapshot();
    await expect(
      f.env.DB.batch([
        f.env.DB.prepare("DELETE FROM mappings WHERE profile_id=?").bind(
          profileA,
        ),
        f.env.DB.prepare("UPDATE profiles SET credentials='' WHERE id=?").bind(
          profileA,
        ),
        f.env.DB.prepare("INSERT INTO mappings VALUES (?,?,?,?,?)").bind(
          "deadbeef",
          "name:Missing",
          "Missing",
          "kb",
          "KB",
        ),
      ]),
    ).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    await f.env.DB.batch([
      f.env.DB.prepare(
        "INSERT INTO profiles(id,name,owner_name,client_fingerprint,credentials) VALUES (?,?,?,?,?)",
      ).bind("d4", "New", "Owner", "synthetic-batch-fingerprint", ""),
      f.env.DB.prepare("INSERT INTO mappings VALUES (?,?,?,?,?)").bind(
        "d4",
        "name:New",
        "New",
        "kb",
        "KB",
      ),
    ]);
    expect(
      f.db
        .prepare("SELECT profile_id FROM mappings WHERE profile_id=?")
        .get("d4"),
    ).toEqual({ profile_id: "d4" });
  });
});

/** Resolve explicit checkpoints instead of relying on scheduler timing in race tests. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("profile verification and concurrent changes", () => {
  test.each([
    ["PUT", "inbox"],
    ["PUT", "mapping"],
    ["POST", "inbox"],
    ["POST", "mapping"],
  ])(
    "%s refuses a verified key that cannot reach the existing %s",
    async (method, missing) => {
      const f = await profileFixture();
      const before = f.snapshot();
      const accessible =
        missing === "inbox" ? `mapped-${profileA}` : `inbox-${profileA}`;
      f.allowVerification(undefined, [
        { id: accessible, name: "Still accessible" },
      ]);
      const response = await f.request(
        method === "POST" ? "/api/profiles" : `/api/profiles/${profileA}`,
        method,
        rotatedProfile,
      );
      expect(response.status).toBe(409);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(before);
      expect(f.remote).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["active job", "inbox", "mapping"])(
    "a concurrent %s change invalidates a pending credential rotation",
    async (change) => {
      const f = await profileFixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      const verify = f.allowVerification();
      f.remote.mockImplementationOnce(async (input, init) => {
        entered.resolve();
        await release.promise;
        return verify(input, init);
      });
      const pending = f.request(
        `/api/profiles/${profileA}`,
        "PUT",
        rotatedProfile,
      );
      await entered.promise;
      if (change === "active job") f.addActiveJob("queued");
      if (change === "inbox")
        f.db
          .prepare(
            "UPDATE profiles SET inbox_id='new-inbox',inbox_name='New inbox' WHERE id=?",
          )
          .run(profileA);
      if (change === "mapping")
        f.db
          .prepare(
            "UPDATE mappings SET kb_id='new-mapping',kb_name='New mapping' WHERE profile_id=?",
          )
          .run(profileA);
      const beforeWrite = f.snapshot();
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(409);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(beforeWrite);
    },
  );

  test("a slow credential verification cannot overwrite a newer successful rotation", async () => {
    const f = await profileFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const verify = f.allowVerification();
    f.remote.mockImplementationOnce(async (input, init) => {
      entered.resolve();
      await release.promise;
      return verify(input, init);
    });
    const slow = f.request(`/api/profiles/${profileA}`, "PUT", rotatedProfile);
    await entered.promise;
    const latest = { ...originalCredentials, apiKey: "synthetic-latest-key" };
    f.allowVerification(latest);
    const fast = await f.request(`/api/profiles/${profileA}`, "PUT", {
      name: "Latest",
      ownerName: "Latest owner",
      ...latest,
    });
    expect(fast.status).toBe(200);
    const afterLatest = f.snapshot();
    release.resolve();
    expect((await slow).status).toBe(409);
    expect(f.snapshot()).toEqual(afterLatest);
    expect(
      await decrypt<Credentials>(
        f.profile().credentials,
        f.env.ENCRYPTION_KEY,
        profileA,
      ),
    ).toEqual(latest);
  });

  test.each(["credentials", "settings", "mappings"])(
    "deletion wins against pending %s validation without resurrecting local data",
    async (action) => {
      const f = await profileFixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      const verify = f.allowVerification(
        action === "credentials" ? undefined : originalCredentials,
      );
      f.remote.mockImplementationOnce(async (input, init) => {
        entered.resolve();
        await release.promise;
        return verify(input, init);
      });
      const path = `/api/profiles/${profileA}${action === "credentials" ? "" : `/${action}`}`;
      const body =
        action === "credentials"
          ? rotatedProfile
          : action === "settings"
            ? { inboxId: `inbox-${profileA}` }
            : { accountName: "New publisher", kbId: `mapped-${profileA}` };
      const pending = f.request(
        path,
        action === "mappings" ? "POST" : "PUT",
        body,
      );
      await entered.promise;
      expect(
        (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
      ).toBe(200);
      const afterDeletion = f.snapshot();
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(409);
      await expectPrivateResponse(response);
      expect(f.snapshot()).toEqual(afterDeletion);
      expect(f.startWorkflow).not.toHaveBeenCalled();
    },
  );

  test.each(["submit", "retry"])(
    "a deletion between the %s precheck and its database write prevents job admission",
    async (action) => {
      const f = await profileFixture();
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      const entered = deferred<void>();
      const release = deferred<void>();
      let paused = false;
      spies.push(
        spyOn(f.env.DB, "prepare").mockImplementation((sql: string) => {
          const statement = prepare(sql);
          const isAdmission =
            action === "submit"
              ? /INSERT.*INTO jobs/i.test(sql)
              : /UPDATE jobs SET stage='queued'/i.test(sql);
          if (!paused && isAdmission) {
            paused = true;
            if (action === "submit") {
              const all = statement.all.bind(statement);
              statement.all = async <T>() => {
                entered.resolve();
                await release.promise;
                return all<T>();
              };
              return statement;
            }
            const run = statement.run.bind(statement);
            statement.run = async <T>() => {
              entered.resolve();
              await release.promise;
              return run<T>();
            };
          }
          return statement;
        }),
      );
      const pending =
        action === "submit"
          ? f.request("/api/jobs", "POST", {
              profileId: profileA,
              urls: ["https://mp.weixin.qq.com/s/new"],
            })
          : f.request(`/api/jobs/${failedJob}/retry`, "POST", {});
      await entered.promise;
      expect(
        (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
      ).toBe(200);
      const afterDeletion = f.snapshot();
      release.resolve();
      expect((await pending).status).toBe(409);
      expect(f.snapshot()).toEqual(afterDeletion);
      expect(f.startWorkflow).not.toHaveBeenCalled();
      expect(f.remote).not.toHaveBeenCalled();
    },
  );

  test("a new job admitted before deletion keeps its account and credentials usable", async () => {
    const f = await profileFixture();
    const admitted = await f.request("/api/jobs", "POST", {
      profileId: profileA,
      urls: ["https://mp.weixin.qq.com/s/new"],
    });
    expect(admitted.status).toBe(202);
    const beforeDeletion = f.snapshot();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(409);
    expect(f.snapshot()).toEqual(beforeDeletion);
    expect(f.startWorkflow).not.toHaveBeenCalled();
    expect(f.profile().deleted_at).toBeNull();
    expect(
      await decrypt<Credentials>(
        f.profile().credentials,
        f.env.ENCRYPTION_KEY,
        profileA,
      ),
    ).toEqual(originalCredentials);
  });

  test("restored deduplication records prevent a second IMA upload for the same article and destination", async () => {
    const f = await profileFixture();
    const before = f.snapshot();
    expect(
      (await f.request(`/api/profiles/${profileA}`, "DELETE", {})).status,
    ).toBe(200);
    f.allowVerification();
    expect(
      (await f.request("/api/profiles", "POST", rotatedProfile)).status,
    ).toBe(201);
    const replayId = "a105";
    const original = f.db
      .prepare<Job, [string]>("SELECT * FROM jobs WHERE id=?")
      .get(completedJob);
    if (!original) throw new Error("Missing history fixture");
    f.db
      .prepare(
        "INSERT INTO jobs(id,profile_id,source_url,url_hash,stage,article_key,file_name,object_key,kb_id) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        replayId,
        profileA,
        original.source_url,
        original.url_hash,
        "saved",
        original.article_key,
        original.file_name,
        original.object_key,
        original.kb_id,
      );
    f.db
      .prepare(
        "UPDATE jobs SET publication_date_checked_at=datetime('now') WHERE id=?",
      )
      .run(replayId);
    f.remote.mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "https://ima.qq.com/openapi/wiki/v1/get_knowledge_list",
      );
      expect(new Headers(init?.headers).get("ima-openapi-clientid")).toBe(
        originalCredentials.clientId,
      );
      expect(new Headers(init?.headers).get("ima-openapi-apikey")).toBe(
        replacementKey,
      );
      expect(JSON.parse(String(init?.body)).knowledge_base_id).toBe(
        `mapped-${profileA}`,
      );
      return Response.json({
        code: 0,
        data: {
          knowledge_list: [
            { media_id: `media-${profileA}`, title: "History.pdf" },
          ],
          is_end: true,
        },
      });
    });
    const workflow = new ImportWorkflow({} as ExecutionContext, f.env);
    const step = {
      async do(_name: unknown, ...args: unknown[]) {
        return (args[args.length - 1] as () => Promise<unknown>)();
      },
    };
    expect(
      await workflow.run(
        { payload: { jobId: replayId } } as never,
        step as never,
      ),
    ).toEqual({ status: "duplicate" });
    expect(
      f.db.prepare("SELECT stage,media_id FROM jobs WHERE id=?").get(replayId),
    ).toEqual({ stage: "duplicate", media_id: `media-${profileA}` });
    expect(f.snapshot().imports).toEqual(before.imports);
    expect(f.snapshot().objects).toEqual(before.objects);
    expect(f.remote).toHaveBeenCalledTimes(2);
  });
});

test("scheduled cleanup preserves history and expired downloads return authenticated HTTP 410", async () => {
  const f = await profileFixture();
  f.db
    .prepare("UPDATE jobs SET completed_at='2020-01-01 00:00:00' WHERE id=?")
    .run(completedJob);
  const imports = f.snapshot().imports;
  await app.scheduled({} as ScheduledController, f.env);
  expect(f.objects.size).toBe(0);
  expect(f.snapshot().imports).toEqual(imports);
  const detail = await f.request(`/api/jobs/${completedJob}`);
  expect(((await detail.json()) as { job: PublicJob }).job).toMatchObject({
    has_pdf: false,
    stage: "complete",
  });
  const download = await f.request(`/api/jobs/${completedJob}/pdf`);
  expect(download.status).toBe(410);
  expect(await download.text()).toContain("备份已过期");
  expect(
    (
      await f.request(`/api/jobs/${completedJob}/pdf`, "GET", undefined, {
        Cookie: "",
      })
    ).status,
  ).toBe(401);
  expect(f.remote).not.toHaveBeenCalled();
});

test("expired R2 archives do not cause another IMA upload when the same article is submitted again", async () => {
  const f = await workflowFixture();
  await f.run();
  f.db
    .prepare(
      "UPDATE jobs SET completed_at='2020-01-01 00:00:00' WHERE id='job'",
    )
    .run();
  const ledger = f.db.prepare("SELECT * FROM imports").all();
  await cleanupExpiredPdfs(f.env);
  expect(f.objects.size).toBe(0);
  f.db
    .prepare(
      "INSERT INTO jobs(id,profile_id,source_url,url_hash) VALUES ('b','account','https://mp.weixin.qq.com/s/abc','hash')",
    )
    .run();
  await f.run("b");
  expect(f.counts()).toEqual({ creates: 1, adds: 1 });
  const duplicate = f.db
    .prepare("SELECT * FROM jobs WHERE id='b'")
    .get() as Job;
  expect(duplicate.stage).toBe("duplicate");
  expect(duplicate.completed_at).not.toBeNull();
  expect(f.db.prepare("SELECT * FROM imports").all()).toEqual(ledger);
  expect(f.objects.size).toBe(1);
});

test("missing publication dates remain explicit and are not replaced by the import date", async () => {
  const f = await workflowFixture();
  f.setPublicationDate(null);
  f.setPutFails(true);
  await expect(f.run()).rejects.toThrow();
  f.setPutFails(false);
  f.setPublicationDate("2026年9月9日");
  await f.run();
  const job = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
  expect(job.file_name).toBe("发布日期未知_An article.pdf");
  expect(job.published_date).toBeNull();
  expect(job.publication_date_checked_at).not.toBeNull();
  expect(f.sourceCounts()).toEqual({ conversions: 1, pdfDownloads: 1 });
});

test("legacy archived retries refresh publication metadata without downloading another PDF", async () => {
  const f = await workflowFixture();
  f.setPutFails(true);
  await expect(f.run()).rejects.toThrow();
  const before = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
  f.db
    .prepare(
      "UPDATE jobs SET published_date=NULL,publication_date_checked_at=NULL,file_name='2026-09-09_An article.pdf' WHERE id='job'",
    )
    .run();
  f.setPutFails(false);
  await f.run();
  const job = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
  expect(job.file_name).toBe("2020-06-18_An article.pdf");
  expect(job.published_date).toBe("2020-06-18");
  expect(job.file_hash).toBe(before.file_hash);
  expect(job.object_key).toBe(before.object_key);
  expect(f.sourceCounts()).toEqual({ conversions: 2, pdfDownloads: 1 });
});

test("already uploaded legacy media keeps its name when reconciling an ambiguous add", async () => {
  const f = await workflowFixture();
  f.setAmbiguous(true);
  await expect(f.run()).rejects.toThrow();
  const before = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
  f.db
    .prepare(
      "UPDATE jobs SET published_date=NULL,publication_date_checked_at=NULL WHERE id='job'",
    )
    .run();
  f.setPublicationDate("2026年9月9日");
  f.setAmbiguous(false);
  await f.run();
  const job = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
  expect(job.file_name).toBe(before.file_name);
  expect(job.media_id).toBe(before.media_id);
  expect(job.stage).toBe("complete");
  expect(f.counts()).toEqual({ creates: 1, adds: 1 });
  expect(f.sourceCounts()).toEqual({ conversions: 1, pdfDownloads: 1 });
});

test.each(["api/mcp", "create_media", "add_knowledge"])(
  "provider 429 at %s durably queues the import and resumes without duplicate media",
  async (endpoint) => {
    const f = await workflowFixture();
    f.throttle(endpoint);
    const requestedAt = Date.now();
    expect(await f.run()).toEqual({ status: "queued" });
    const job = f.db.prepare("SELECT * FROM jobs WHERE id='job'").get() as Job;
    expect(job.stage).toBe("queued");
    expect(job.workflow_id).toBeNull();
    expect(job.add_state).toBeNull();
    const control = f.db
      .prepare("SELECT cooldown_until FROM import_queue_control")
      .get() as { cooldown_until: string };
    expect(
      Date.parse(`${control.cooldown_until.replace(" ", "T")}Z`),
    ).toBeGreaterThanOrEqual(requestedAt + 3600000);
    const before = f.counts();
    f.throttle(null);
    f.db
      .prepare(
        "UPDATE import_queue_control SET cooldown_until='2000-01-01 00:00:00'",
      )
      .run();
    await f.run();
    expect(f.counts()).toEqual({ creates: 1, adds: 1 });
    expect(f.sourceCounts()).toEqual({ conversions: 1, pdfDownloads: 1 });
    if (endpoint === "add_knowledge") expect(before.creates).toBe(1);
  },
);

test("authenticated batch API accepts more than ten links and reports the persistent queue", async () => {
  const f = await profileFixture();
  const response = await f.request("/api/jobs", "POST", {
    profileId: profileA,
    urls: Array.from(
      { length: 60 },
      (_, i) => `https://mp.weixin.qq.com/s/bulk-${i}`,
    ),
  });
  expect(response.status).toBe(202);
  expect(((await response.json()) as { jobs: PublicJob[] }).jobs).toHaveLength(
    60,
  );
  const history = await f.request(`/api/jobs?profile=${profileA}`);
  expect(
    ((await history.json()) as { queue: { queued: number } }).queue.queued,
  ).toBe(60);
  expect(f.startWorkflow).not.toHaveBeenCalled();
});
