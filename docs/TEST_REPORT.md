# Final end-to-end verification

Run on 2026-11-04 against the local Docker Compose PostgreSQL database and Vite/Express development servers.

## Core build checklist

- [x] **PASS — Member registry:** farmer IDs, village/land details, and bank information are modeled; farmer access is centre-scoped; no Aadhaar field is present. Evidence: schema and farmer-route review; operator login and centre farmer list loaded in browser.
- [x] **PASS — Offline collection entry and SMS:** online purchase flow saved a Soybean Grade A purchase (100 kg gross, 2 kg tare, 12% moisture, 98 kg net, ₹4,753.00) and displayed the Marathi SMS slip with the purchase values. Evidence: browser flow on 2026-11-04; API and SMS tests.
- [ ] **PARTIAL — Daily price board:** backend manager endpoints and daily crop/grade price rules exist and are covered by tests, but there is no manager price-board screen in the frontend routes. This is a UI completeness gap, not verified end-to-end in the UI.
- [x] **PASS — Payment run:** approved purchases appear in manager payment-run history; API smoke test created and approved a run, exported CSV (200), then received 409 on a second export. Evidence: live API smoke test and manager payment-run screen.
- [x] **PASS — Roles and access control:** operator and manager demo logins both succeeded; route guards and API role/centre scopes enforce access. Evidence: live browser logins and route/middleware review.
- [ ] **PARTIAL — OCR and anomaly review:** OCR provider, mismatch checks, anomaly rules, and manager review are implemented and covered by tests. The browser purchase was completed without OCR, and a live OCR.space scan was not run because no OCR API key is configured. Flagged review is implemented; the separate manager dashboard UI is missing.
- [ ] **PARTIAL — Offline sync:** HMAC signing, replay/timestamp checks, and retryable queue handling are implemented; transient failed results remain queued with `lastError`. Automated backend tests and code review cover the sync contract, but a browser offline/reconnect retry was not exercised in this run.
- [x] **PASS — Marathi SMS:** live purchase confirmation displayed the Marathi slip with farmer, crop, weights, moisture, rate, amount, and centre; SMS template/idempotency tests pass.

## Frontend completeness checklist

- [x] **PASS — Login:** lazy-loaded background and role-based login tested in browser for operator and manager.
- [x] **PASS — Operator: Find Farmer:** seeded farmer list loaded and was usable in browser.
- [ ] **PARTIAL — Operator: New Purchase:** four-step purchase flow saved successfully in browser; OCR upload/reconciliation was not exercised with a real OCR provider.
- [ ] **PARTIAL — Operator: Purchase Detail:** purchase confirmation and SMS preview were exercised; the standalone purchase-detail route was not separately smoke-tested.
- [ ] **FAIL — Manager: Price Board:** no price-board frontend screen or route exists; backend API only.
- [x] **PASS — Manager: Flagged Review:** manager route loaded and showed its empty state; approval behavior was verified in the live API smoke test.
- [x] **PASS — Manager: Payment Run:** manager history loaded; payment-run create/approve/export and re-export rejection were verified by the live API smoke test.
- [ ] **FAIL — Manager: Dashboard:** dashboard summary API exists, but no manager dashboard screen or route exists in the frontend.
- [x] **PASS — Offline/Sync indicator:** operator queue dock shows online/offline and sync status; code path includes retry action.

## Responsive check

- At 360 CSS pixels, the Find Farmer screen had no horizontal overflow.
- The Manager Payment Runs screen initially overflowed by a few pixels. The run-history labels were made wrap-safe; recheck at 360 CSS pixels reported a 360-pixel document width and no overflowing elements.
- Other routes were not exhaustively checked at 360 pixels; responsive verification is therefore partial rather than a blanket pass.

## Local end-to-end run

- Docker PostgreSQL service: running.
- `npm run migrate --prefix backend`: passed; pending SMS idempotency migration applied and Prisma Client generated.
- `npm run seed --prefix backend`: passed; demo sample data loaded.
- `npm run dev`: backend and frontend started successfully.
- Browser: operator login, farmer search, multi-step purchase, and Marathi SMS preview passed; manager login, flagged-review empty state, and payment-run history loaded.
- API smoke: flagged repeat purchase, manager approval, payment-run creation/approval, first CSV export (200), and re-export rejection (409) passed.
- Repository screenshot: [docs/screenshots/manager-payment-runs.png](./screenshots/manager-payment-runs.png).

## Automated validation

- Backend: 73/73 tests passed (`cd backend && npm test -- --run`).
- Typecheck: passed (`npm run typecheck`).
- Backend production build: passed (`npm run build --prefix backend`).
- Frontend production build: passed (`npm run build --prefix frontend`).
- Formatting: passed (`npm run format`).

## Remaining submission gaps

- Implement or explicitly exclude the manager Price Board and Dashboard UI according to the final client acceptance criteria.
- Configure OCR.space credentials and run a real provider scan before claiming live OCR verification.
- Exercise offline capture/retry in a browser with network interruption.
- Complete responsive checks for every route at 360 pixels.
- The app is local-only and not deployed; no live app URL is available.
