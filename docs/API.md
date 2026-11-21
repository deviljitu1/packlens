# Operate without manual dashboard clicks

The API is available on `http://127.0.0.1:4310` while `npm start` runs. Use the included TypeScript scripts with `node --import tsx` from the project folder. No external deployment is required.

| Action | Route / command |
| --- | --- |
| Inspect Excel/CSV | `npm run inspect -- <file>` |
| Import all product sheets | `node --import tsx scripts/import-workbook.ts <file>` |
| Catalog / conflicts | `GET /api/products?scope=main` or `scope=conflicts` |
| Overview counts | `GET /api/overview` |
| Name-based automatic pilot | `POST /api/automation/start`, `{ "limit":5, "pilotOnly":true }` |
| Bounded non-pilot selection | same route with `{ "pilotOnly":false, "codes":["001","002"] }` |
| Queue controls | `POST /api/jobs/control`, `{ "action":"pause" }` / resume / stop |
| Codex auth/quota | `POST /api/visual/status` |
| Shortlisted visual review | `POST /api/visual/queue`, `{ "candidateIds":["uuid"], "pilotOnly":false }` |
| Retain an approved unchanged original | `POST /api/candidates/<id>/prepare-original`, `{ "qualityReviewed":true, "qualityNotes":"..." }`; rights clearance is required |
| Upgrade an OCR fallback | same route with `upgradeFallback:true`; successful unchanged Codex results remain cached |
| Review folder inventory | `GET /api/review-folders` |
| Detect deletions / prepare files | `POST /api/review-folders/scan` |
| Open folder in Explorer | `POST /api/review-folders/open` |
| Commercial ZIP | `POST /api/export`, `{ "incremental":true }` |
| Separate reports | `GET /api/reports/all`, review, photo or audit (CSV) |

`npm run automate -- 50` starts the pilot, follows persisted search/visual jobs and writes a local outcome report. No product URLs are mandatory. A completed run may honestly contain blocked sources, missing views and no commercial-ready ZIP.

The dashboard and scripts preserve source/job decisions in SQLite. Do not delete `data/` to recover an interrupted queue. Stop/restart the processes normally. Back up the data folder for long-term retention; it is deliberately excluded from the public skill repository.

Current scope is download-only. The image-altering endpoint is disabled. Original extension, dimensions and bytes are preserved; store-specific formatting compatibility must be assessed separately.
