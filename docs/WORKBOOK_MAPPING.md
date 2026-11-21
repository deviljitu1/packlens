# Workbook mapping

Auto-detect headers rather than column positions. The mapping screen can select another source header for each field. Preserve all original columns, source sheet/row, import file and instructions.

| Field | Common headers |
| --- | --- |
| code | Item Code, Item Code (= file name), SKU, ItemCode, Code |
| name | Our Item Name, Item Name, Title, Name |
| productName | Product Name |
| brand | Brand |
| size | Size, Pack Size |
| barcodeText | Barcode(s), Barcode, EAN, GTIN |
| department | Department |
| strategy | Source Strategy |
| suggestedSearch | Suggested Search |
| conflict | Why, Reviewer Notes |

Codes are text, including zero-padded numeric cell formats. Multiple barcode candidates retain their original text and a normalized list. Missing barcodes are valid. Invalid/missing codes, missing names and duplicate codes in a sheet are row-level errors; original uploaded files remain preserved.

Reimport upserts existing codes. Identity changes invalidate approvals. Conflict-only sheets such as Existing conflicts / Check first remain separate from main-catalog counts and are never silently approved. Own-brand photography instructions route to real photo capture instead of lookalikes.

The importer handles valid SpreadsheetML namespace prefixes produced by some exporters by normalizing only the parser's in-memory copy. It does not rewrite the source file. Supported bounds are 100,000 rows and 200 columns per sheet; default uploads are capped at 50 MB.
