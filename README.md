# Morneven Backend

Backend implementation for Morneven Institute based on:
- `BERequierment.md` (API + RBAC contract)
- `Analasis BE Requierment.md` (architecture + relational schema guidance)

## Tech Stack
- Node.js + Express + TypeScript
- PostgreSQL + Prisma ORM
- JWT authentication (`access` + `refresh` token)
- Zod validation

## Project Structure
```text
src/
  config/        # env + prisma client
  middleware/    # auth guard + RBAC rules
  modules/       # feature routers by domain
    auth/
    projects/
    lore/
    gallery/
    map/
    personnel/
    settings/
    news/
  types/         # shared TS types + Express augmentation
  utils/         # shared response helper
  server.ts      # bootstrap + route mounting
prisma/
  schema.prisma
  seed.ts
```

## Documentation Files
- `APIdocumentation.md` → Backend API references, RBAC notes, and request/response examples.
- `BERequierment.md` → Original requirement contract source.
- `Analasis BE Requierment.md` → Technical recommendation and relational design analysis.

## Environment Variables
Create `.env` from `.env.example` and fill placeholders:

```env
DATABASE_URL="postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?schema=public"
JWT_ACCESS_SECRET="<JWT_ACCESS_SECRET_PLACEHOLDER>"
JWT_REFRESH_SECRET="<JWT_REFRESH_SECRET_PLACEHOLDER>"
PORT=3000
```

## Local Development
```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

## Deployment Guide

### 1) Infrastructure Preparation
- Provision a PostgreSQL instance (managed or self-hosted).
- Create a dedicated database user with least-privilege access to the target DB.
- Prepare runtime environment variables (`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PORT`).

### 2) Build Artifact
```bash
npm install
npm run prisma:generate
npm run build
```

### 3) Database Migration (Production)
Use deployment-safe migration command in production pipeline:
```bash
npx prisma migrate deploy
```

### 4) Optional Initial Seed
Only run once for non-production or first-time staging setup:
```bash
npm run prisma:seed
```

### 5) Run Service
```bash
npm run start
```

### 6) Health Check
Verify service is live:
```bash
curl http://<HOST>:<PORT>/health
```
Expected response:
```json
{ "success": true, "data": { "status": "ok" } }
```

### 7) Reverse Proxy / Gateway Notes
- Route API under `/api/*` as defined by backend routers.
- Enforce HTTPS termination at gateway/load balancer.
- Restrict network access to PostgreSQL from backend runtime only.

### 8) Rollback Strategy (Recommended)
- Keep previous build artifact/tag.
- Roll back app deployment first.
- If DB migration rollback is needed, use explicit Prisma migration resolution with caution and backup snapshots.

## Seed Data
`prisma/seed.ts` seeds:
- L7 executive admin user
- L6 mechanic user
- settings, project + patch, news + attachment
- lore item + doc, gallery item + tags + discussion
- map markers + map image

> Seed uses placeholder URLs and non-production credentials.

## API Base URL
Development base path uses `/api`.
