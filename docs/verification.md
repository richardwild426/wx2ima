# Verification record

This record omits deployment identifiers, domains, account details, knowledge-base names, source article metadata, object hashes, and credentials.

## Automated verification

Type checking, linting, and 82 tests (1,114 assertions) passed at the latest application change. Tests use an in-memory SQLite adapter and synthetic provider fixtures, without real credentials.

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
