# Farmers Payment App

Offline-first procurement and payment MVP for a farmer producer company in Maharashtra.

## Prerequisites

- Node.js 20+
- Docker for local PostgreSQL
- npm

## Quick start

Start Docker Desktop, then from PowerShell in the repository root:

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
