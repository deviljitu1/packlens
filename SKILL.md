---
name: packlens
description: Download and visually verify exact product photographs from Excel or CSV catalogs without editing images. Use for original-file downloads, confidence-folder review and replacement of deleted images, with a locally authenticated Codex account instead of a separately billed API integration.
---

# PackLens

Build and operate a real local catalog-image workflow. The bundled application is the implementation template; do not replace it with a mockup or stop at a development plan.

**Current scope is download-only. Preserve the original image bytes, source format and resolution. Do not remove backgrounds, crop, resize, sharpen, denoise, upscale or convert images.** Reading an image for verification is allowed; changing the downloaded file is not.

## Start and inspect

- Use the current clone as the app workspace, or run `node <skill-root>/scripts/create-project.mjs <destination>` to copy a clean application into the user's workspace. Preserve an existing project and its data.
- Node.js 24+ is required. Run `npm ci`, `npm run setup:browser`, `npm run build`, then `npm start`. Windows users can use `start.bat`. The dashboard binds to `127.0.0.1:4310`; worker processes continue when dashboard tabs close.
- Inspect the actual workbook before importing. Use `npm run inspect -- <workbook>` and `node --import tsx scripts/import-workbook.ts <workbook>` against the running app. Map headers, retain original rows/instructions, preserve item codes and leading zeros, and report validation errors. Candidate Excel barcodes are not verified identities.
- Main catalog counts must exclude separate conflict-only sheets. Reimports upsert by item code, retain origins, and invalidate approval if identity changes.

## Operate automatically

- Start a small pilot, then at most 50 products: `npm run automate -- 5` or `npm run automate -- 50`. The pilot selection uses the `Pilot 50` origin sheet when present. For another catalog, use `POST /api/automation/start` with `pilotOnly:false` and a bounded list of codes. Do not launch a whole production catalog externally before reviewing the pilot evidence.
- Product URLs are not required. Search public authorized catalog APIs from the product names. For missing results, the bounded Codex researcher can find manufacturer/licensed sources and open permitted pages in visible Chrome/Chromium. It extracts original image URLs from page metadata and `srcset`, rather than saving search thumbnails or screenshots.
- Respect actual source authorization, domain allowlists, throttles and cooldowns. A public page, robots permission or search result alone is not commercial image clearance. Unknown access policies remain exceptions. Never bypass CAPTCHA, login, 403/429 blocks or source restrictions. Keep marketplace adapters disabled without established access and reuse permission.
- Source outages remain retryable failures. Preserve one underlying error and a fixed backoff time; skipping an already-paused source must not append recursive errors or extend its cooldown. Retry a bounded number of times after backoff, then retain a visible exception.

## Verify exact products and good images

- Prefer five distinct genuine views of one exact source SKU: full front, full back, nutrition, FSSAI/license details where available, and another useful view. Five is the default maximum and complete-set target. Do not invent absent views or count duplicated crops as distinct photographs.
- Reject poor internet images. The default floor is 800 pixels on the long edge and 400 on the short edge. Measure sharpness/detail, and check full pack, legible labels, watermark, screenshot, cropped labels and editing artifacts. Find a better original instead of trying to repair a poor image.
- Use the saved ChatGPT-authenticated Codex CLI with image attachments, structured JSON, read-only sandbox and no shell tools for visual review. Do not add OpenAI API-key authentication or a separately billed API client. Check account mode and quota windows, record token usage, pause at the configured threshold, and use local OCR/manual review when unavailable. Do not buy credits or consume quota resets automatically.
- Cache by image hash, catalog identity, source evidence and review-policy version. Reuse unchanged results. A completed OCR/manual fallback may be explicitly upgraded to Codex without repeating a completed Codex review.
- Combine visible observations with deterministic brand, variant, measurement, pack-count, promotion and source-confirmed barcode checks. Hard mismatches veto HIGH. Ambiguous sizes, missing identity evidence and own-brand lookalikes stay under review. Barcode values copied from Excel alone do not prove a match.
- Corroborate front/back observations only within a visually consistent, source-confirmed SKU/barcode and page. Never borrow size or variant evidence from another listing. Preserve the per-image observations and explanations. Scores are provisional rules, not calibrated probabilities; human-reviewed precision is a separate metric.

## Confidence folders and deletion review

- `data/Product Images/High confidence`, `Medium confidence` and `Low confidence` are the user's review location. Copy original files byte-for-byte, named `<item_code>_<sequence>.<original extension>`. Front is 1 and back is 2; other available views occupy 3–5. JPEG/PNG/WebP source formats remain unchanged. Do not create fake files for missing views.
- Keep the app and review worker running. When the user deletes a file, confirm its absence across scans, persist rejection/exclusion, and queue another image for the same item/view/sequence. Do not reuse its rejected hash or URL. Preserve originals and audit history.
- A missing category folder/root marker pauses deletion detection rather than rejecting the whole catalog. Preserve edited/untracked files rather than overwriting them. Moving a file between confidence categories is an app action, not a user rejection.
- Retaining a review file is not automatic approval or commercial-use permission. Keep review files separate from commercial-ready exports.

## Preserve originals, export and verify

- Output is the unchanged source file. Rename it with the item code and sequence while preserving its original extension. Check SHA-256 equality between downloaded original, review copy and exported copy. Report actual MIME and dimensions; never silently convert to a store format or imply an incompatible source is upload-ready.
- Windows OCR is available when its language pack works; configured Tesseract is another local option. OCR and Codex analyze the original without changing its stored bytes. Do not install or invoke background removal, AI upscaling or other image-altering tools for this download skill.
- A commercial ZIP requires identity approval, recorded commercial-use rights/verifier, quality PASS, original-byte equality, existing valid files, five distinct approved slots and required front/back. Include sequence/view, source, rights, reviewer, actual dimensions and checksum in the manifest. Unverified/prohibited rights and incomplete sets remain outside it.
- Run `npm test`, `npm run build` and the relevant browser test `npm run test:e2e`. Default tests use synthetic catalogs generated in code; never label fixture results as live extraction. Run explicitly permitted live checks separately. Report actual files/counts and known restrictions. Never claim all products have images or that store uploads were tested without evidence.

Read [source policy](docs/SOURCE_POLICY.md) for source decisions, [API operations](docs/API.md) to control the app without manual UI clicks, and [architecture](docs/ARCHITECTURE.md) when extending the pipeline. Never publish user workbooks, images, databases, credentials, browser profiles or downloaded models with this skill.
