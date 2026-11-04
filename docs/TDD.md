# Farmers Payment App

Repository URL: TBD — set to the GitHub repo before public submission.
Live app URL: local only, not deployed; run locally via Docker Compose + Vite + Express.

## 1) Architecture

The app is split into a plain Express + TypeScript backend and a Vite + React frontend with Dexie-backed offline queueing for operator devices. The backend persists to PostgreSQL via Prisma and exposes a JSON API consumed by the frontend. The project follows a single-centre operator model for procurement and a manager-only review/export flow for payment operations.

```text
+---------------------+         +------------------------+
| Browser / Operator  | <----> | React + Vite frontend  |
| 360px mobile flow   |         | TypeScript / Dexie     |
+----------+----------+         +-----------+------------+
           |                                  |
           | HTTPS / JSON API                | IndexedDB queue
           v                                  v
+---------------------+         +------------------------+
| Express API         | <----> | PostgreSQL (Prisma)    |
| JWT auth + routes   |         | centres / farmers /    |
| OCR / sync / runs   |         | purchases / payment     |
+---------------------+         | runs / audit trail     |
                                +------------------------+
```

## 2) Data model summary

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

## 3) API contract

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/farmers`
- `POST /api/v1/farmers`
- `GET /api/v1/farmers/:id`
- `PUT /api/v1/farmers/:id`
- `GET /api/v1/price-board`
- `POST /api/v1/price-board`
- `PUT /api/v1/price-board/:id`
- `GET /api/v1/purchases`
- `POST /api/v1/purchases`
- `PATCH /api/v1/purchases/:id/review`
- `POST /api/v1/ocr/parse`
- `POST /api/v1/sync/purchases`
- `POST /api/v1/payment-runs`
- `GET /api/v1/payment-runs`
- `GET /api/v1/payment-runs/:id`
- `PATCH /api/v1/payment-runs/:id/approve`
- `GET /api/v1/payment-runs/:id/export`
- `GET /api/v1/sms/:purchaseId`
- `GET /api/v1/dashboard/summary`

## 4) Business rules contract

- Net weight = `gross - tare`.
- Moisture deduction applies to full percentage points above 12%.
- Net weight is rounded to one decimal place before pricing.
- Amount is calculated in integer paise; no float storage.
- Price board is per crop/grade/effectiveDate with one valid price per day.
- Tare cannot exceed gross.
- Flagged purchases require manager review and audit logging.
- Payment runs move through `DRAFT -> APPROVED -> EXPORTED`.
- A payment run cannot be exported twice.

### Anomaly review rules

| Trigger             | Rule                                                                                                   | Handling                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `YIELD_CAP`         | Net weight exceeds 1,500 kg/acre for soybean or 1,000 kg/acre for tur; equality at the cap is allowed. | Persist as `FLAGGED` and include the limit in the reason. |
| `REPEATED_FARMER`   | Same farmer has a purchase in the previous 60 minutes.                                                 | Persist as `FLAGGED`; do not cancel or overwrite.         |
| `MOISTURE_VARIANCE` | At least five same-centre/day readings vary by less than 0.5 percentage points.                        | Persist as `FLAGGED`; exact 0.5 does not trigger.         |

Moisture comparisons use UTC calendar days and use the purchase device timestamp when present; older purchases without a device timestamp fall back to creation time. Managers must provide a reason when approving or rejecting a flagged purchase. Approval changes `FLAGGED` to `APPROVED`; rejection changes it to `REJECTED`.

## 5) OCR flow

```text
Operator uploads image -> multer validation -> provider factory -> raw text parse -> parseOcrText()
        -> p95/low-confidence check -> OcrJob row persisted -> purchase creation validates OCR mismatch
```

Notes:

- Uploads accept JPEG, PNG, GIF, and WebP with max size 1 MiB.
- `OCR_PROVIDER=mock` switches to the in-memory mock provider; production uses OCR.space.
- Parsed values are stored in `ocr_jobs`, including raw text, confidence, and `purchase_id` once linked.
- If the operator enters values that differ from OCR without explicit reconciliation, creation fails with `OCR_MISMATCH`.

## 6) Offline sync sequence diagram

```text
Operator -> Frontend Dexie: queue purchase payload
Frontend -> Frontend: sign payload with HMAC device secret
Frontend -> API: POST /api/v1/sync/purchases
API -> API: verify HMAC + device session + nonce + timestamp ordering
API -> DB: create purchase / mark FLAGGED if conflict found
API -> SyncLog: ACCEPTED or REJECTED with reason
API -> Frontend: accepted rejected results
Frontend -> Dexie: remove accepted rows; keep retryable queue entries for rejected/transient failures
```

### Retry policy choice

The project adopts a retryable queue policy: failed sync entries stay `QUEUED` with `lastError` preserved unless the failure is a permanent validation issue that the backend can never recover from. This preserves the TDD contract and prevents silent data loss while waiting for connectivity or a later resubmission.

## 7) Marathi SMS slip contract

The exact template is:

`रसीद {slip_no} | शेतकरी: {farmer_name} | {crop_name} | सकल वजन: {gross_kg} किलो | कच्चा वजन: {tare_kg} किलो | ओलावा: {moisture_pct}% | शुद्ध वजन: {net_kg} किलो | दर: ₹{rate}/क्विंटल | रक्कम: ₹{amount} | केंद्र: {centre_code}`

The mock SMS gateway stores exactly one log row per synced purchase in `sms_outbox` using the unique `purchase_id` constraint. `GET /api/v1/sms/:purchaseId` returns the stored slip preview for the operator’s centre. Flagged purchases do not produce slips; approval does not retroactively send one.

## 8) Key assumptions and ambiguity notes

- Kamal Shinde rounding ambiguity: the business rule states net weight is rounded to one decimal after moisture deduction; the project uses `Math.round(value * 10) / 10`, which is consistent with the canonical test case and accepted as the rule.
- SMS timing for flagged purchases: flagged purchases do not generate slips, even after approval; TDD explicitly documents this and the app follows it.
- Device secret handling: both server and client treat device keys as temporary secrets returned at login and store only the SHA-256 hash on the server.
- No Aadhaar field exists anywhere in the schema or app contract; DPDP minimum-data principle is respected.

## 9) What we cut

The MVP intentionally excludes deeper operational features not needed for the client brief, including:

- truck dispatch or logistics management
- multi-warehouse stock dashboards
- advanced analytics beyond the daily summary dashboard
- deep procurement forecasting or external bank integration beyond a mock CSV export

## 10) What we'd build next

- full farmer/member onboarding workflow with consent capture audit history
- end-to-end mobile app packaging with real OCR provider and push/pull sync service
- audit dashboards and exception management beyond the current flag review screen
- production-grade bank integration and reconciliation exports
