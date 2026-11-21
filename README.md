# PackLens

A reusable Codex **download-only** skill and Windows-local application for finding and verifying product photographs from Excel/CSV catalogs. It uses a saved ChatGPT Codex login and SQLite. No separately billed OpenAI API integration.

Original image bytes, format and resolution are preserved. No background removal, cropping, resizing, sharpening, denoising, AI upscaling or conversion is used.

## Run locally

Install Node.js 24 or newer. In this folder:

```powershell
npm ci
npm run setup:browser
npm run build
npm start
```

Open [the dashboard](http://127.0.0.1:4310). Windows can also double-click `start.bat`. Keep the terminal running; closing dashboard tabs does not stop workers. Use Ctrl+C to stop, and restart normally to recover queued work. `npm run dev` runs the development frontend on port 5173.

Import a workbook through the dashboard, or let Codex run:

```powershell
node --import tsx scripts/import-workbook.ts "C:\path\catalog.xlsx"
npm run automate -- 5
```

The default pilot selector looks for a `Pilot 50` sheet. Other catalogs are supported through mapped import and bounded API selection; see [API operations](docs/API.md).

## Use as a Codex skill

Clone this repository into your Codex skills folder as `packlens`, or ask Codex's skill installer to install `deviljitu1/packlens`. Invoke:

```text
Use $packlens to process my catalog, start with five products, and prepare confidence folders for review.
```

The root [SKILL.md](SKILL.md) contains the operating instructions. A clean app can be copied elsewhere with `node scripts/create-project.mjs <destination>`.

## Review files

Images are stored locally under `data/`:

- `originals/`: preserved downloads/photos.
- `Product Images/High confidence`, `Medium confidence`, `Low confidence`: unchanged review images. Delete disliked files; the running worker records rejection and searches different replacements.
- `approved-originals/`: approved unchanged copies.
- `exports/`: commercially cleared ZIPs with manifests.
- `db/`: SQLite catalog, jobs, verification cache and audit.

The target is five genuine exact-product views, including full front and back. Nutrition/FSSAI details are included when available. Filenames use `<item_code>_1.<original extension>` through `_5.<original extension>`, for example `11_1.jpg`, `11_2.png`. Source formats/resolutions stay unchanged. Missing views are reported; unrelated photos and duplicate crops are not substitutes.

Review-folder files are not automatically commercially approved. A final commercial export requires approved identity, cleared reuse rights, quality checks and the complete image set.

## Codex and OCR

Codex CLI must be installed and logged in using ChatGPT (`codex login`). Visual reviews run in batches of 1–3, cache results, track usage and pause on quota limits. API-key auth is rejected.

Windows OCR, or optional Tesseract, provides a read-only fallback. Image alteration is disabled. No models or user images are shipped in this repository.

## Validation and limits

```powershell
npm test
npm run build
npm run test:e2e
```

Tests generate synthetic catalog/image fixtures in an ignored test directory and verify source-byte equality in review folders and exports. To test a private pilot file, set `PACKLENS_PILOT_FILE` to its path; it stays local.

Public catalog APIs, source policies and websites can change. The generic browser adapter is tested against owned fixtures; accessible real-source extraction and Codex review have also been tested, but this does not certify every website. Marketplace adapters are disabled unless authorization is established. Blocked sources back off; uncertain packaging stays under review. Live store uploads and compatibility of every unchanged source format/resolution are not verified. See [test evidence](docs/TEST_RESULTS.md) and [source policy](docs/SOURCE_POLICY.md).

This repository contains code, skill instructions and procedural tests only. User catalogs, photographs, databases, credentials, browser profiles and downloaded models are excluded.
