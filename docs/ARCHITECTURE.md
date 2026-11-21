# Architecture

React/Vite provides the local dashboard. Express binds to loopback only, validates requests with Zod and rejects cross-origin mutation requests. SQLite uses WAL, schema initialization and typed repositories. No cloud service or Redis is required.

`scripts/launch.ts` starts separate API, source-queue, visual-review and review-folder processes. Source/visual jobs persist in SQLite and recover after interruption. Worker leases prevent duplicate owners. Pause/stop settle in-flight requests; stop cancels unstarted work. Source failures do not abort the catalog.

Pipeline: mapped import → permitted original download → explainable text/barcode checks → Codex visual checks or local OCR → unchanged confidence-folder copies → optional human decisions → quality/rights/complete-set gates → original-file ZIP.

`src/sources.ts` defines `SourceAdapter.search`, `getCandidates`, `fetchImage`, `health` and `authorization`. Public catalog adapters are isolated from browser extraction. Images are validated by MIME, decoding, dimensions and checksum. The browser uses isolated contexts and domain restrictions, with no stealth, CAPTCHA bypass or unauthorized login.

`src/discovery.ts` uses the locally authenticated Codex CLI for bounded web research. Newly discovered access-policy quotes must be independently present and affirmative before automated download; access and commercial reuse remain separate. The browser saves originals from source URLs. Unknown permissions become exceptions.

Download-only mode preserves source bytes and disables image alteration. Sharp reads metadata/quality measurements; it does not rewrite review/export images. Verification keys include source image hash, catalog attributes, source evidence and policy version. Different views can corroborate one source-confirmed SKU, while deterministic mismatches and quality vetoes remain enforced. Results, decisions and usage persist in SQLite. SHA-256 equality is checked on copies and exports.

The review-folder inventory links each filename to item, sequence, candidate and hash. Deletion across stable scans creates a durable rejection and replacement request. Root/category disappearance pauses detection; user edits are preserved. Commercial exports revalidate current assets and snapshot state before recording success.

Known bounds: source queue concurrency is 1; visual batches contain at most 3 images; automated pilots are capped at 50 products per request. Default browser research is limited to 5 new searches per day. Quota/token budgets are stop thresholds, and an in-flight request can exceed a local token threshold. This is an initial local application, not a certified precision model or universal scraper.
