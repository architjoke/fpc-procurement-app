# Farmers Payment App

Offline-first procurement and payment MVP for a farmer producer company in Maharashtra.

## Tech stack

- Backend: Express + TypeScript + Prisma + PostgreSQL
- Frontend: React + Vite + TypeScript
- Offline sync: Dexie + IndexedDB + HMAC-SHA256 device signatures
- AI/OCR: OCR.space provider (with mock fallback for CI and local regression tests)
- Auth: JWT access + refresh tokens

## Prerequisites

- Node.js 20+
- Docker for local PostgreSQL
- npm

## Quick start

1. Start Docker Desktop and ensure Docker Compose is available.
2. From the repository root, install dependencies:
   ```powershell
   npm run install:all
   ```
3. Run the database migration and seed data:
   ```powershell
   npm run migrate
   npm run seed
   ```
4. Start the app locally:
   ```powershell
   npm run dev
   ```
5. Open the frontend at `http://localhost:5173` and the API at `http://localhost:5000`.

```powershell
docker compose up -d postgres
Copy-Item backend\.env.example backend\.env
# Fill backend\.env with local settings described in backend\README.md.
npm run migrate --prefix backend
npm run seed --prefix backend
npm run install:all
npm run dev
```

Docker PostgreSQL is exposed on port 5433 to avoid colliding with an existing local PostgreSQL on 5432. Set `DATABASE_URL` to `postgresql://postgres:postgres@localhost:5433/farmers_payment_app?schema=public`.

Open Prisma Studio in a separate terminal with `npm run studio --prefix backend`.
The app starts the Express backend on port 5000 and the Vite frontend on port 5173.

## Included modules

- Member registry
- Offline purchase capture with SMS slip generation
- Price board management
- Payment run export
- OCR integration via OCR.space
- HMAC-backed offline sync flow
