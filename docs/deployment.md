# Deployment notes

## Local run steps

Run these commands from the repository root in PowerShell. Install Docker Desktop and Node.js 20+ first.

1. Create a root `.env` file for Docker Compose with values you choose for `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Create `backend\.env` from `backend\.env.example` and set `DATABASE_URL` to connect to that database on port `5433`, plus the backend settings listed below. Create `frontend\.env` from `frontend\.env.example` only if you need to override the frontend API URL. Keep all `.env` files local; do not commit or submit them.
2. Start PostgreSQL with Docker Compose:
   ```powershell
   docker compose up -d postgres
   ```
   PostgreSQL is exposed on port `5433` to avoid conflicts with a local PostgreSQL service on port `5432`.
3. Install all project dependencies:
   ```powershell
   npm run install:all
   ```
4. Apply the database migrations:
   ```powershell
   npm run migrate
   ```
5. Seed the demo dataset:
   ```powershell
   npm run seed
   ```
6. Start the backend and frontend:
   ```powershell
   npm run dev
   ```
7. Open the frontend at `http://localhost:5173`. The API listens at `http://localhost:5000`.

## Deployment status

The application is not deployed to a public hosting provider. The supported setup in this repository is local development: PostgreSQL runs in Docker Compose, and the backend and frontend run with the development command above. There is no live application URL or production hosting procedure to provide.

## Environment variables

Docker Compose (root `.env`):

- POSTGRES_USER
- POSTGRES_PASSWORD
- POSTGRES_DB

Backend environment variable names (set values in `backend\.env`; do not commit or submit that file):

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

Frontend environment variable names (set values in `frontend\.env` if overriding the default):

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
