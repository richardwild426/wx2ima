import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { Env } from "../src/types";
export const fetchTarget = globalThis as unknown as {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
// Match Workers' fixed-size upload contract while using Bun's in-memory streams.
Object.assign(globalThis, {
  FixedLengthStream: class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number) {
      let transferred = 0;
      super({
        transform(chunk, controller) {
          transferred += chunk.length;
          if (transferred > length) throw new Error("Length exceeded");
          controller.enqueue(chunk);
        },
        flush() {
          if (transferred !== length) throw new Error("Length mismatch");
        },
      });
    }
  },
});
export function testEnv({ applyRetentionMigration = true } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0002_add_outcome.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0003_profile_deletion.sql", import.meta.url),
      "utf8",
    ),
  );
  if (applyRetentionMigration)
    db.exec(
      readFileSync(
        new URL("../migrations/0004_pdf_retention.sql", import.meta.url),
        "utf8",
      ),
    );
  db.exec(
    readFileSync(
      new URL(
        "../migrations/0005_article_publication_date.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  function prepare(sql: string) {
    let bindings: unknown[] = [];
    function execute() {
      const result = db.prepare(sql).run(...(bindings as never[]));
      return { success: true, meta: { changes: result.changes } };
    }
    return {
      execute,
      bind(...values: unknown[]) {
        bindings = values;
        return this;
      },
      async first() {
        return db.prepare(sql).get(...(bindings as never[]));
      },
      async all() {
        return {
          results: db.prepare(sql).all(...(bindings as never[])),
          success: true,
        };
      },
      async run() {
        return execute();
      },
    };
  }
  const objects = new Map<string, Uint8Array>();
  const env = {
    DB: {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        /** D1 rolls back the entire batch; Bun transactions must finish synchronously. */
        return db.transaction(() => statements.map((s) => s.execute()))();
      },
    },
    PDFS: {
      async delete(key: string) {
        objects.delete(key);
      },
      async put(key: string, value: Uint8Array) {
        objects.set(key, new Uint8Array(value));
      },
      async head(key: string) {
        return objects.has(key) ? { size: objects.get(key)?.length } : null;
      },
      async get(key: string) {
        const data = objects.get(key);
        return data
          ? {
              size: data.length,
              body: new Response(new Uint8Array(data).buffer).body,
            }
          : null;
      },
    },
    ASSETS: {
      async fetch() {
        return new Response("Static asset");
      },
    },
    IMPORTS: {
      async create() {
        return { id: "test-workflow" };
      },
      async get() {
        return {
          async status() {
            return { status: "running" };
          },
        };
      },
    },
    ENCRYPTION_KEY: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64"),
    ACCESS_PASSWORD_HASH: "",
    APP_ORIGIN: "https://wx.example.com",
  } as unknown as Env;
  return { env, db, objects };
}
