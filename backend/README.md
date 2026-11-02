# Backend setup

## Local PostgreSQL with Docker

```bash
docker compose up -d postgres
```

Make sure Docker Desktop is running first. In PowerShell, create the ignored local environment file:

```powershell
Copy-Item .env.example .env
```

Set these variables in `backend/.env` (do not commit this file):

- `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/farmers_payment_app?schema=public`
- `JWT_SECRET` and `JWT_REFRESH_SECRET` to separate random secrets
- `PORT=5000`
- `OCR_SPACE_API_KEY` (optional; required for live OCR)
- `OCR_PROVIDER=mock` selects the local mock provider; OCR.space is the default.
- `CORS_ORIGIN=http://localhost:5173`

## Database and seed

Run from the repository root:

```bash
npm run migrate --prefix backend
npm run seed --prefix backend
npm run dev
```

After pulling schema changes, run migrations again with `npm run migrate --prefix backend`.

Open Prisma Studio from the repository root:

```bash
npm run studio --prefix backend
```

Demo users:

- operator@demo.in / demo123
- manager@demo.in / demo123
