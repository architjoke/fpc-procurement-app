# TDD and architecture notes

## Architecture

The project is split into a plain Express + TypeScript backend and a Vite + React frontend. They communicate over a typed API client.

## Data model

- centres
- farmers
- crops
- price_board
- purchases
- device_sessions
- sync_nonces
- payment_runs
- payment_run_items
- sync_log
- audit_trail
- sms_outbox
- ocr_jobs

## API contract

- POST /api/v1/auth/login
- POST /api/v1/auth/refresh
- GET /api/v1/farmers
- POST /api/v1/farmers
- GET /api/v1/price-board
- POST /api/v1/price-board
- PUT /api/v1/price-board/:id
- POST /api/v1/purchases
- PATCH /api/v1/purchases/:id/review
- POST /api/v1/ocr/parse
- POST /api/v1/sync/purchases
- POST /api/v1/payment-runs
- GET /api/v1/payment-runs/:id/export
- GET /api/v1/sms/:purchaseId
- GET /api/v1/dashboard/summary

## Business rules

- Net weight = gross - tare.
- Moisture deduction applies to full percentage points above 12%.
- Amount is calculated using integer paise with no floating-point drift.
- A crop and grade can have only one price per effective calendar date.
- Online purchase rates are selected from the current daily price board; client-supplied rates are rejected.
- Tare weight cannot exceed gross weight; calculated net weight is rounded to one decimal before pricing.
- Entry review and audit logging are enforced for flagged purchases.

## OCR flow

1. An authenticated centre operator uploads a JPEG, PNG, GIF, or WebP photo (maximum 1 MiB).
2. The OCR provider factory selects OCR.space using `OCR_SPACE_API_KEY`, or a mock provider when
   `OCR_PROVIDER=mock`; routes depend only on the `OcrProvider` interface.
3. OCR numeric values are parsed from raw text, including `kg`/`%` suffixes, decimal commas, and
   common OCR character substitutions. Unreadable/low-confidence scans return `OCR_UNREADABLE` or
   `OCR_UNAVAILABLE` with HTTP 422 so manual entry remains available.
4. Every valid upload result is persisted as an operator-owned `ocr_jobs` row. `image_url` stores a
   SHA-256 reference to the uploaded bytes; raw bytes are not retained by the application.
5. Purchase creation loads the job for the current operator and stores its confidence and image
   reference. Changed prefilled values require an explicit reconciliation flag; otherwise the
   purchase service returns `OCR_MISMATCH`.
6. OCR metadata is carried and HMAC-signed when a purchase must enter the offline sync queue.

## Offline sync flow

1. Mobile client stores queued records in IndexedDB.
2. On reconnect, client signs queued payloads with an HMAC device key.
3. Backend verifies signature, rejects replays, and logs every result.
4. Any conflict is escalated to a flagged purchase for manager review.

### Offline purchase signature format

The client sends each batch item with `hmac_signature` excluded from the signed content. The
remaining fields are serialized in this exact key order:

`centre_id`, `crop_id`, `device_timestamp`, `farmer_id`, `grade`, `gross_kg`, `moisture_pct`,
`nonce`, `rate_per_quintal`, `tare_kg`, `uuid`.

Each component is `key=encodeURIComponent(value)`; components are joined by `|`. Timestamps are
normalized to UTC ISO-8601 with milliseconds, and numbers use JavaScript's canonical `String(number)`
representation. HMAC-SHA256 uses the device secret returned at operator login and emits lowercase
hex. When OCR is attached, defined optional fields (`ocr_job_id`, `ocr_moisture`,
`ocr_moisture_reconciled`, `ocr_weight`, `ocr_weight_reconciled`) are appended after the base fields
in that lexicographic order; undefined optional fields are omitted. The batch sends the device ID
and device secret in `x-device-id` and `x-device-secret` headers. The server stores only a SHA-256
hash of each device secret and expires consumed nonces after 24 hours.

## Assumptions and future work

- Operator device secrets are issued at login and stored server-side only as SHA-256 hashes.
- Payment export uses a mock bank CSV format.
- OCR.sample images are present under frontend/public for local verification.
- The project focuses on the core workflow rather than deeper dispatch or stock analytics.

## DPDP 2023 note

Consent is captured at farmer registration, the use is limited to procurement and payment, and only the minimum necessary fields are stored.
