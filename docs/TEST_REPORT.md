# Final end-to-end verification

Run on 2026-11-04 against the local Docker Compose PostgreSQL database and Vite/Express development servers.

## Core build checklist

- [x] **PASS — Member registry:** farmer IDs, village/land details, and bank information are modeled; farmer access is centre-scoped; no Aadhaar field is present. Evidence: schema and farmer-route review; operator login and centre farmer list loaded in browser.
- [x] **PASS — Offline collection entry and SMS:** online purchase flow saved a Soybean Grade A purchase (100 kg gross, 2 kg tare, 12% moisture, 98 kg net, ₹4,753.00) and displayed the Marathi SMS slip with the purchase values. Evidence: browser flow on 2026-11-04; API and SMS tests.
- [x] **PASS — Daily price board:** manager price-board screen loaded current rates, added a scheduled rate, updated an existing entry, and displayed the API’s 409 duplicate-date error. The same price-board API supplies rates to all centres. Evidence: live browser check and daily price-board API/business-rule tests.
- [x] **PASS — Payment run:** non-flagged purchases are automatically marked `APPROVED` and appear in the manager payment-eligible list; live API verification created a run from a normal purchase, approved it, exported CSV (200), then received 409 on a second export.
- [x] **PASS — Roles and access control:** operator and manager demo logins both succeeded; route guards and API role/centre scopes enforce access. Evidence: live browser logins and route/middleware review.
- [ ] **PARTIAL — OCR and anomaly review:** OCR provider, mismatch checks, anomaly rules, and flagged review are implemented and covered by tests. The browser purchase was completed without OCR, and a live OCR.space scan was not run because no OCR API key is configured; deeper anomaly analytics beyond flagged review are out of scope.
- [ ] **PARTIAL — Offline sync:** HMAC signing, replay/timestamp checks, and retryable queue handling are implemented; transient failed results remain queued with `lastError`. Automated backend tests and code review cover the sync contract, but a browser offline/reconnect retry was not exercised in this run.
- [x] **PASS — Marathi SMS:** live purchase confirmation displayed the Marathi slip with farmer, crop, weights, moisture, rate, amount, and centre; SMS template/idempotency tests pass.

## Frontend completeness checklist

- [x] **PASS — Login:** lazy-loaded background and role-based login tested in browser for operator and manager.
- [x] **PASS — Operator: Find Farmer:** seeded farmer list loaded and was usable in browser.
- [ ] **PARTIAL — Operator: New Purchase:** four-step purchase flow saved successfully in browser; OCR upload/reconciliation was not exercised with a real OCR provider.
- [ ] **PARTIAL — Operator: Purchase Detail:** purchase confirmation and SMS preview were exercised; the standalone purchase-detail route was not separately smoke-tested.
- [x] **PASS — Manager: Price Board:** current/scheduled entries, add, edit, refresh, loading/error/empty states are implemented; live browser checks covered add, edit, and duplicate-rate handling.
- [x] **PASS — Manager: Flagged Review:** manager route loaded and showed its empty state; approval behavior was verified in the live API smoke test.
- [x] **PASS — Manager: Payment Run:** manager history loaded; payment-run create/approve/export and re-export rejection were verified by the live API smoke test.
- [x] **PASS — Manager: Dashboard:** dashboard screen loaded today’s purchase count, pending amount, and centre activity from the existing summary API.
- [x] **PASS — Offline/Sync indicator:** operator queue dock shows online/offline and sync status; code path includes retry action.

## Responsive check

- At 360 CSS pixels, the Find Farmer screen had no horizontal overflow.
- The Manager Payment Runs screen initially overflowed by a few pixels. The run-history labels were made wrap-safe; recheck at 360 CSS pixels reported a 360-pixel document width and no overflowing elements.
- Manager Dashboard, Price Board, Flagged Review, and Payment Runs also had no horizontal overflow at 360 CSS pixels.
- All four purchase-wizard steps had no horizontal overflow at 360 CSS pixels. Login and the standalone purchase-detail route were not separately checked at that width.

## Local end-to-end run

- Docker PostgreSQL service: running.
- `npm run migrate --prefix backend`: passed; pending SMS idempotency migration applied and Prisma Client generated.
- `npm run seed --prefix backend`: passed; demo sample data loaded.
- `npm run dev`: backend and frontend started successfully.
- Browser: operator login, farmer search, multi-step purchase, and Marathi SMS preview passed; manager login, flagged-review empty state, and payment-run history loaded.
- Browser manager screens: dashboard loaded centre metrics; price board added a future rate, updated an existing rate, and surfaced the duplicate-rate conflict.
- Workflow verification: a successful non-flagged purchase was automatically marked `APPROVED`, appeared in the eligible list, and completed through payment-run approval, CSV export, and duplicate-export rejection.
- Responsive browser check: Find Farmer, all purchase wizard steps, and the manager Dashboard, Price Board, Flagged Review, and Payment Runs had no horizontal overflow at 360 CSS pixels.
- API smoke: flagged repeat purchase, manager approval, payment-run creation/approval, first CSV export (200), and re-export rejection (409) passed.
- Repository screenshots: [price board](./screenshots/manager-price-board.png) and [payment runs](./screenshots/manager-payment-runs.png).

## Automated validation

- Backend: 73/73 tests passed (`cd backend && npm test -- --run`).
- Typecheck: passed (`npm run typecheck`).
- Backend production build: passed (`npm run build --prefix backend`).
- Frontend production build: passed (`npm run build --prefix frontend`).
- Formatting: passed (`npm run format`).

## Remaining submission gaps

- Configure OCR.space credentials and run a real provider scan before claiming live OCR verification.
- Exercise offline capture/retry in a browser with network interruption.
- Complete responsive checks for every route at 360 pixels.
- The app is local-only and not deployed; no live app URL is available.
