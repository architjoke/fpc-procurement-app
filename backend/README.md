# Backend setup

## Local PostgreSQL with Docker

```bash
docker compose up -d postgres
```

Create a local `.env` file with the required values:

```bash
cp .env.example .env
```

Then fill in:

- DATABASE_URL
- JWT_SECRET
- JWT_REFRESH_SECRET
- PORT
- OCR_SPACE_API_KEY
- CORS_ORIGIN

## Database and seed

```bash
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

Demo users:

- operator@demo.in / demo123
- manager@demo.in / demo123
