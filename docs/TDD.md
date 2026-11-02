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

1. Operator uploads a photo of a scale or moisture meter.
2. Backend calls OCR.space when configured.
3. Numeric values are parsed and returned as prefilled values.
4. Operator confirms or corrects the values before save.
5. If the OCR result differs from the typed value, the save is blocked until reconciled.

## Offline sync flow

1. Mobile client stores queued records in IndexedDB.
2. On reconnect, client signs queued payloads with an HMAC device key.
3. Backend verifies signature, rejects replays, and logs every result.
4. Any conflict is escalated to a flagged purchase for manager review.

### Offline purchase signature format

The client sends each batch item with `hmac_signature` excluded from the signed content. The
remaining fields are serialized in this exact lexicographic key order:

`centre_id`, `crop_id`, `device_timestamp`, `farmer_id`, `grade`, `gross_kg`, `moisture_pct`,
`nonce`, `rate_per_quintal`, `tare_kg`, `uuid`.

Each component is `key=encodeURIComponent(value)`; components are joined by `|`. Timestamps are
normalized to UTC ISO-8601 with milliseconds, and numbers use JavaScript's canonical `String(number)`
representation. HMAC-SHA256 uses the device secret returned at operator login and emits lowercase
hex. The batch sends the device ID and device secret in `x-device-id` and `x-device-secret` headers.
The server stores only a SHA-256 hash of each device secret and expires consumed nonces after 24
hours.

## Assumptions and future work

- Operator device secrets are issued at login and stored server-side only as SHA-256 hashes.
- Payment export uses a mock bank CSV format.
- OCR.sample images are present under frontend/public for local verification.
- The project focuses on the core workflow rather than deeper dispatch or stock analytics.

## DPDP 2023 note

Consent is captured at farmer registration, the use is limited to procurement and payment, and only the minimum necessary fields are stored.
