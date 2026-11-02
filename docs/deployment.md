# Deployment notes

## Local run steps

1. Start PostgreSQL via Docker Compose.
2. Copy backend `.env.example` to `.env` and fill in the variable names required by the app.
3. Copy frontend `.env.example` to `.env` and set `VITE_API_URL`.
4. Run:

```bash
npm run install:all
npm run dev
```

## Demo credentials

- Operator: `operator@demo.in` / `demo123`
- Manager: `manager@demo.in` / `demo123`

## Environment variables

Backend:

- DATABASE_URL
- JWT_SECRET
- JWT_REFRESH_SECRET
- PORT
- OCR_SPACE_API_KEY
- CORS_ORIGIN

Frontend:

- VITE_API_URL
