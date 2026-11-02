# Farmers Payment App

Offline-first procurement and payment MVP for a farmer producer company in Maharashtra.

## Prerequisites

- Node.js 20+
- Docker for local PostgreSQL
- npm

## Quick start

```bash
npm run install:all
npm run dev
```

This starts the Express backend on port 5000 and the Vite frontend on port 5173.

## Included modules

- Member registry
- Offline purchase capture with SMS slip generation
- Price board management
- Payment run export
- OCR integration via OCR.space
- HMAC-backed offline sync flow
