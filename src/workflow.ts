import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { fileName } from "./article";
import {
  findExact,
  ima,
  type Media,
  repeatedName,
  uploadCos,
  validateBase,
} from "./ima";
import {
  convertArticle,
  download,
  MAX_PDF_BYTES,
  metadata,
  validatePdf,
} from "./mcp";
import { decrypt, digest, publicError } from "./security";
import { jobById, profile, updateJob } from "./store";
import { AppError, type Credentials, type Env, type Mapping } from "./types";

export class ImportWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    try {
      await step.do(
        "archive-pdf",
        {
          retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
          timeout: "6 minutes",
        },
        async () => {
          const job = await jobById(this.env, id);
          if (job.object_key && (await this.env.PDFS.head(job.object_key)))
            return;
          await updateJob(this.env, id, { stage: "downloading", error: null });
          const links = await convertArticle(job.source_url);
          const html = await download(links.html, 3 * 1024 * 1024);
          const info = await metadata(html, job.source_url);
          const articleKey = info.canonical
            ? `url:${await digest(info.canonical)}`
            : (info.identity ?? `url:${job.url_hash}`);
          await updateJob(this.env, id, {
            stage: "validating",
            title: info.title,
            account_name: info.publisher || null,
            account_key: info.accountKey,
            article_key: articleKey,
          });
          const pdf = await download(links.pdf, MAX_PDF_BYTES);
          const pages = await validatePdf(pdf);
          const filename = fileName(info.title, job.created_at.slice(0, 10));
          const objectKey = `pdf/${job.profile_id}/${id}.pdf`;
          await this.env.PDFS.put(objectKey, pdf, {
            httpMetadata: {
              contentType: "application/pdf",
            },
          });
          await updateJob(this.env, id, {
            file_name: filename,
            object_key: objectKey,
            file_size: pdf.length,
            file_hash: await digest(pdf),
            page_count: pages,
            stage: "saved",
          });
        },
      );
      const skip = await step.do(
        "resolve-destination",
        { retries: { limit: 1, delay: "10 seconds" }, timeout: "2 minutes" },
        async () => {
          const job = await jobById(this.env, id);
          const account = await profile(this.env, job.profile_id);
          const creds = await decrypt<Credentials>(
            account.credentials,
            this.env.ENCRYPTION_KEY,
            account.id,
          );
          if (!job.kb_id) {
            const mapping = job.account_key
              ? await this.env.DB.prepare(
                  "SELECT * FROM mappings WHERE profile_id=? AND account_key IN (?,?) ORDER BY CASE WHEN account_key=? THEN 0 ELSE 1 END LIMIT 1",
                )
                  .bind(
                    account.id,
                    job.account_key,
                    `name:${(job.account_name ?? "").normalize("NFKC")}`,
                    job.account_key,
                  )
                  .first<Mapping>()
              : null;
            const kbId = mapping?.kb_id ?? account.inbox_id;
            if (!kbId)
              throw new AppError("请为此 IMA 账号选择待分类知识库。", 409);
            const kb = await validateBase(creds, kbId);
            await updateJob(this.env, id, {
              kb_id: kb.id,
              kb_name: kb.name,
              used_inbox: mapping ? 0 : 1,
            });
          }
          const current = await jobById(this.env, id);
          await this.env.DB.prepare(
            "INSERT OR IGNORE INTO imports(profile_id,article_key,kb_id,job_id) VALUES (?,?,?,?)",
          )
            .bind(current.profile_id, current.article_key, current.kb_id, id)
            .run();
          const claim = await this.env.DB.prepare(
            "SELECT * FROM imports WHERE profile_id=? AND article_key=? AND kb_id=?",
          )
            .bind(current.profile_id, current.article_key, current.kb_id)
            .first<{
              job_id: string;
              media_id: string | null;
              status: string;
            }>();
          if (claim?.job_id !== id) {
            if (claim?.status === "complete" && claim.media_id) {
              const existing = await findExact(
                creds,
                current.kb_id as string,
                current.file_name as string,
                claim.media_id,
              );
              if (existing) {
                await updateJob(this.env, id, {
                  stage: "duplicate",
                  media_id: existing.media_id,
                });
                return true;
              }
              await this.env.DB.prepare(
                "UPDATE imports SET job_id=?,status='pending',media_id=NULL WHERE profile_id=? AND article_key=? AND kb_id=? AND status='complete'",
              )
                .bind(
                  id,
                  current.profile_id,
                  current.article_key,
                  current.kb_id,
                )
                .run();
              const owner = await this.env.DB.prepare(
                "SELECT job_id FROM imports WHERE profile_id=? AND article_key=? AND kb_id=?",
              )
                .bind(current.profile_id, current.article_key, current.kb_id)
                .first<{ job_id: string }>();
              if (owner?.job_id !== id)
                throw new AppError(
                  "此文章的另一个导入任务正在进行，请等待其完成后重试。",
                  409,
                );
            } else {
              throw new AppError(
                "此文章已有导入任务正在进行，请重试原任务。",
                409,
              );
            }
          }
          return false;
        },
      );
      if (skip) return { status: "duplicate" };
      await step.do(
        "upload-pdf",
        { retries: { limit: 1, delay: "15 seconds" }, timeout: "4 minutes" },
        async () => {
          const job = await jobById(this.env, id);
          const account = await profile(this.env, job.profile_id);
          const c = await decrypt<Credentials>(
            account.credentials,
            this.env.ENCRYPTION_KEY,
            account.id,
          );
          // A persisted successful upload can be reused after add_knowledge or verification fails.
          if (job.media_id && job.cos_key) return;
          await updateJob(this.env, id, { stage: "uploading" });
          let assigned = false;
          // Reserve names atomically so parallel imports cannot select the same free IMA name.
          // Recompute from the title on retries; article identity remains in the imports ledger.
          for (let copy = 1; copy <= 100; copy++) {
            const candidate = fileName(
              job.title ?? "微信公众号文章",
              job.created_at.slice(0, 10),
              copy,
            );
            if (await repeatedName(c, job.kb_id as string, candidate)) continue;
            const reservation = await this.env.DB.prepare(
              "UPDATE jobs SET file_name=?,updated_at=datetime('now') WHERE id=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE profile_id=? AND kb_id=? AND file_name=? AND id<>? AND stage<>'duplicate')",
            )
              .bind(candidate, id, job.profile_id, job.kb_id, candidate, id)
              .run();
            if (!reservation.meta.changes) continue;
            job.file_name = candidate;
            assigned = true;
            break;
          }
          if (!assigned)
            throw new AppError(
              "同名 PDF 数量过多，请整理目标知识库后重试。",
              409,
            );
          const object = await this.env.PDFS.get(job.object_key as string);
          if (!object)
            throw new AppError("已保存的 PDF 丢失，请重新创建导入任务。", 409);
          const media = await ima<Media>(c, "create_media", {
            file_name: job.file_name,
            file_size: object.size,
            content_type: "application/pdf",
            knowledge_base_id: job.kb_id,
            file_ext: "pdf",
          });
          if (!media.media_id || !media.cos_credential)
            throw new AppError("IMA 未返回上传信息。", 502);
          await uploadCos(media.cos_credential, object.body, object.size);
          await updateJob(this.env, id, {
            media_id: media.media_id,
            cos_key: media.cos_credential.cos_key,
            stage: "uploaded",
          });
        },
      );
      await step.do(
        "add-to-ima",
        { retries: { limit: 1, delay: "20 seconds" }, timeout: "2 minutes" },
        async () => {
          const job = await jobById(this.env, id),
            account = await profile(this.env, job.profile_id);
          const c = await decrypt<Credentials>(
            account.credentials,
            this.env.ENCRYPTION_KEY,
            account.id,
          );
          await updateJob(this.env, id, { stage: "adding" });
          // Reconcile an ambiguous prior write before sending another add request.
          const existing = await findExact(
            c,
            job.kb_id as string,
            job.file_name as string,
            job.media_id as string,
          );
          if (existing) return;
          // A timeout cannot distinguish a lost response from a lost request. Reconcile only.
          if (job.add_state) return;
          await updateJob(this.env, id, { add_state: "pending" });
          try {
            await ima(c, "add_knowledge", {
              media_type: 1,
              media_id: job.media_id,
              title: job.file_name,
              knowledge_base_id: job.kb_id,
              file_info: {
                cos_key: job.cos_key,
                file_size: job.file_size,
                file_name: job.file_name,
              },
            });
            await updateJob(this.env, id, { add_state: "accepted" });
          } catch (error) {
            if (error instanceof AppError && error.status === 422) {
              await updateJob(this.env, id, { add_state: null });
            }
            throw error;
          }
        },
      );
      await step.do(
        "verify-entry",
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => {
          const job = await jobById(this.env, id),
            account = await profile(this.env, job.profile_id);
          const c = await decrypt<Credentials>(
            account.credentials,
            this.env.ENCRYPTION_KEY,
            account.id,
          );
          await updateJob(this.env, id, { stage: "verifying" });
          const entry = await findExact(
            c,
            job.kb_id as string,
            job.file_name as string,
            job.media_id as string,
          );
          if (!entry)
            throw new AppError(
              "暂未在 IMA 中查到导入条目，请重试以核验结果，重试不会重复上传。",
              502,
            );
          await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE imports SET media_id=?,status='complete' WHERE profile_id=? AND article_key=? AND kb_id=? AND job_id=?",
            ).bind(
              entry.media_id,
              job.profile_id,
              job.article_key,
              job.kb_id,
              id,
            ),
            this.env.DB.prepare(
              "UPDATE jobs SET stage='complete',error=NULL,updated_at=datetime('now') WHERE id=?",
            ).bind(id),
          ]);
        },
      );
      return { status: "complete" };
    } catch (error) {
      await step.do("record-failure", async () => {
        await updateJob(this.env, id, {
          stage: "failed",
          error: publicError(error),
        });
      });
      // D1 carries the actionable failure; throwing marks the Workflow as failed too.
      throw new Error("Import failed. See the import record for details.");
    }
  }
}
