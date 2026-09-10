# Verification record

This record omits deployment identifiers, domains, account details, knowledge-base names, source article metadata, object hashes, and credentials.

## Automated verification

Type checking, linting, and 176 tests (1,383 assertions) passed at the latest application change. Tests use an in-memory SQLite adapter and synthetic provider fixtures, without real credentials.

Coverage includes:

- Password sessions, cross-origin protection, rate limits, and encrypted credential storage.
- Account metadata editing, verified credential rotation, deletion, rollback, and reconnecting without losing deduplication history.
- Concurrent account changes, job submission, retries, and routing updates.
- Source URL and download-host validation, metadata identity checks, PDF parsing, and size limits.
- Provider response validation and complete knowledge-list pagination.
- Fallback and publisher-specific routing, independent account scopes, and article deduplication.
- Failed COS uploads, archive reuse, and reconciliation after an ambiguous IMA add response.
- Readable PDF names, Chinese title sanitization, local and remote name conflicts, and retrying without stacking filename suffixes.

## Live workflow acceptance

A public article completed conversion through Changfeng MCP, PDF validation, private R2 archival, COS upload, and independently verified IMA knowledge entries in two designated test destinations. A repeat import into the same destination did not create a second IMA entry. Downloaded PDF bytes matched the archived integrity record.

Temporary routing and acceptance fixtures were removed after testing. Permanent routing was configured by the owner. Real account information and resource identifiers are intentionally omitted here.

Live testing identified an unsupported Worker fetch redirect mode; external calls now use manual redirect handling, and authenticated requests never follow redirects. COS uploads use a fixed-length stream so the transmitted Content-Length matches the signed request.

## Interface checks

The authenticated dashboard, account details, routing settings, login page, Chinese status labels, and validation messages were inspected. A synthetic invalid login visibly showed a disabled loading button, then restored the enabled button and displayed a Chinese error.

Temporary DOM interaction checks covered account form prefill, optional credential validation, deletion errors, read-only historical accounts, stale dialog responses, immediate loading feedback, duplicate suppression, redraw persistence, and success/error restoration.

No completed live account edit/delete flow is claimed. Those paths were checked through automated API tests and frontend interaction simulation. The filename change passed automated checks and deployment validation; no additional live IMA upload was performed specifically for that change.

## Operational limits

The tested PDF included image-based text and imperfect page breaks. Verified IMA entry creation does not imply completed OCR or indexing. A successful sample is not a guarantee for larger or more complex PDFs under a deployment's Cloudflare resource limits.

Previously uploaded IMA entries retain their original filenames. New imports use readable names without article-hash or job-ID suffixes.

## One-year PDF retention

- Confirmed complete and duplicate jobs retain their R2 backup for 365 days after verification. Failed, uncertain, active, and unverified jobs are excluded. Legacy verified terminal jobs use their previous update timestamp as the completion timestamp.
- The Worker has a daily 19:00 UTC (03:00 Asia/Shanghai) scheduled handler. Each run processes at most 20 due archives, leaving excess work for later runs. It deletes R2 objects before marking the records, preserves import history and deduplication claims, and never deletes IMA content or requires account credentials.
- Tests cover the exact expiry boundary, late verification of old jobs, protected states, deleted accounts, R2 failure isolation, D1 failure reconciliation after deletion, overlapping invocations, bounded batches, migration backfill, authenticated HTTP 410 responses, and repeat submissions after archive expiry without another IMA upload.
- Frontend interaction simulation covered expired, retained, unknown-expiry, and invalid-expiry records. Expired backups have no download link; retained backups include the expiry date in their download hint when known.
- The production migration completed without deleting objects. Existing records were below the retention age. Automated tests exercised the scheduled handler; no live expired-object deletion is claimed for this release.

## Publication-date filenames

- New filenames use the article's publication day in Asia/Shanghai, persisted independently of job creation and completion timestamps. Collisions and retries reuse that day. Missing, invalid, incomplete, or conflicting publication signals produce an explicit unknown-publication-date filename instead of substituting the upload date.
- A live public article's converted HTML contained a Chinese date in `#publish_time` and a second empty placeholder. Parsing the actual response returned its correct publication day. Fixtures cover that structure, explicit publication metadata, Unix seconds, timezone boundaries, invalid calendar dates, and exclusion of prose, modification dates, and download dates.
- Workflow tests cover an older article imported today, collisions and retries retaining its publication date, unknown dates remaining unknown, and metadata refresh for a legacy archive without another PDF download. Already uploaded media retains its existing name when reconciling an ambiguous IMA write.
- The publication date does not shorten the 365-day retention period, which still starts at successful IMA verification. Existing uploaded entries are not renamed. This release did not perform an additional real IMA upload.

## Persistent import queue

- The paste limit and twenty-active-job rejection were replaced with automatic browser chunking and atomic D1 enqueue acknowledgments. Transport chunks are bounded, but the browser has no total link-count cap. Accepted chunks survive closed pages; unacknowledged input remains available after errors.
- A conditional D1 update reserves one global workflow slot. Completion and failure kick the next job; a per-minute cron reconciles killed workflows and uncertain creation responses, reusing the original instance ID. Existing queue entries and new submissions cannot race into parallel conversion jobs.
- Explicit provider throttling is persisted as workflow step output and returns the import to the queue with a global cooldown. HTTP Retry-After supports seconds and HTTP dates; long waits are not slept through inside a Worker. Explicitly rejected IMA additions clear their pending marker before retry; ambiguous network outcomes retain it and reconcile instead.
- Tests cover a hundred-link queue, simultaneous duplicate submissions, competing dispatchers, FIFO handoff, creation-response loss, stopped workflows, transient status errors, queue cooldown, chunk rollback, authenticated bulk submission, and throttling at conversion, media creation, and IMA addition. Provider tests cover documented rate errors, unread response cancellation, malformed Retry-After values, and non-retryable ambiguous failures.
- Frontend simulation passed thirteen scenarios covering chunk sizing, full preflight validation, acknowledgment-only input removal, edited text, partial failures, fixed account selection, logout races, and queue summaries.
- Provider investigation found no published numeric QPS, concurrency, or daily-request quota for Changfeng or IMA. The IMA ten-URL limit applies to a different endpoint; this application uploads PDFs. Serial admission is a local conservative policy, with explicit provider throttling taking precedence.
- Live acceptance used two isolated synthetic jobs with pre-seeded PDF archives and deliberately unusable synthetic account credentials. The minute cron started the first job without a browser request, and its expected local credential failure handed off to the second job. Both reached the expected failed state with separate workflow instances. This exercised scheduling and failure recovery without calling article conversion or writing to IMA. Synthetic records and archive objects were removed afterward.
