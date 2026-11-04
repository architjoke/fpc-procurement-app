# Deployment notes

## Local run steps

1. Start PostgreSQL and any supporting services with Docker Compose.
2. Install all project dependencies:
   ```bash
   npm run install:all
   ```
3. Run the Prisma migration:
   ```bash
   npm run migrate --prefix backend
   ```
4. Seed the demo dataset:
   ```bash
   npm run seed --prefix backend
   ```
5. Start the app in development mode:
   ```bash
   npm run dev
   ```
6. Open the frontend at `http://localhost:5173` and the backend at `http://localhost:5000`.

## Environment variables

Backend environment variables (names only; values are project-specific and must be set in `.env`):

- DATABASE_URL
- JWT_SECRET
- JWT_REFRESH_SECRET
- PORT
- CORS_ORIGIN
- OCR_SPACE_API_KEY
- OCR_PROVIDER
- OCR_MOCK_TEXT
- OCR_MOCK_CONFIDENCE
- OCR_MOCK_FAIL

Frontend environment variables (names only; values are project-specific and must be set in `.env`):

- VITE_API_URL

## Demo credentials

- Operator: `operator@demo.in` / `demo123`
- Manager: `manager@demo.in` / `demo123`

## Smoke-test sequence

1. Login as the operator.
2. Create a purchase with a valid farmer and crop.
3. Confirm the offline queue and sync status update.
4. Login as the manager.
5. Review any flagged purchase.
6. Create and approve a payment run.
7. Export the CSV and confirm the run cannot be exported a second time.
