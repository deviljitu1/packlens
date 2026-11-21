# Test evidence and limitations

Validation performed on Windows with Node.js 26.10.0. Node 24+ is the supported application requirement; this record does not claim every Node/Windows combination was exercised.

Verified during development:

- Actual 50-row pilot import and idempotent reimport; 69 conflict records preserved.
- Actual 17,751-row production workbook parsed in approximately 1.4 seconds and imported in 2.0 seconds on the development computer; reimport retained 17,751 unique catalog rows. Conflict-only records are reported separately.
- Real public catalog API and browser extraction for a 5 kg flour example. A selected full-size source image measured 895×1200. ChatGPT-authenticated Codex reviewed it and retained MEDIUM because the visible weight was missing. Source barcode metadata alone did not erase the visual uncertainty.
- Built-in Windows OCR executed on the same photograph.
- The current workflow is download-only. Source bytes, original format and resolution are preserved; image-altering commands are disabled. Earlier processed review copies were archived outside the review folders.
- Browser-driven mapped import, reimport, conflict separation, review, rights gate, five-image set, original-file ZIP/manifest, mobile overflow check, 403 source fallback, abrupt worker termination and restart/resume recovery passed against owned synthetic fixtures. Each of the five exported originals was checked for byte equality with its input.
- Unit/integration tests cover deterministic pack/variant/size/promo vetoes, rights/export gates, source pause without recursive errors, Codex quota fallback/cache, 50-row fixture routing, original-byte confidence folders, deletion rejection, same-slot replacement, edited-file preservation, policy-verified browser fallback fixtures, same-SKU front/back corroboration and explicit mapping of unfamiliar headers. Run `npm test` for the current test count.

The real 50-product automatic source run encountered HTTP 503 after initial queries. The app paused the source, retained affected products for retry and did not manufacture missing images. No commercially cleared production export resulted from that run.

Default repository tests generate catalogs and images procedurally. Synthetic transport results are never evidence of 50 real visual verifications. The public repository contains no user workbook, photograph, database, browser profile, model weight or credential.

Untested/restricted: universal manufacturer discovery, every retailer adapter, real five-view coverage for every pilot product, calibrated match probabilities, perfect blur/watermark recognition, and live store bulk-upload compatibility. Dynamic policy discovery is bounded and conservative; unknown authorization remains an exception. Unchanged source files may not meet store-specific format/dimension/byte limits; the download skill reports those properties rather than changing images.
