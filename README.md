# Morneven Backend

Backend implementation for Morneven Institute based on:
- `BERequierment.md` (API + RBAC contract)
- `Analasis BE Requierment.md` (architecture + relational schema guidance)

## Tech Stack
- Node.js + Express + TypeScript
- PostgreSQL + Prisma ORM
- JWT authentication (`access` + `refresh` token)
- Zod validation

## Latest Update Alignment (Production Hardening)
The current implementation has been updated with:
- Security middleware: Helmet, CORS allowlist, global rate limiting (+ stricter auth limiter), and compression.
- Fail-fast environment validation via Zod.
- Stronger auth validation (registration password minimum 12 chars).
- Hashed refresh token storage in DB.
- Request body validation middleware for write endpoints.
- Operational safeguards: 1MB JSON limit, 404 fallback, graceful shutdown hooks, request-id propagation, health + readiness probe endpoints.

## Project Structure
```text
src/
  config/        # env + prisma client
  middleware/    # auth guard + RBAC rules + validation + security
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
- `APIdocumentation.md` → Backend API references, RBAC notes, security behavior, and request/response examples.
- `BERequierment.md` → Original requirement contract source.
- `Analasis BE Requierment.md` → Technical recommendation and relational design analysis.

## Environment Variables
Create `.env` from `.env.example` and fill placeholders:

```env
DATABASE_URL="postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?schema=public"
JWT_ACCESS_SECRET="<JWT_ACCESS_SECRET_PLACEHOLDER>"
JWT_REFRESH_SECRET="<JWT_REFRESH_SECRET_PLACEHOLDER>"
PORT=3000
NODE_ENV="development"
CORS_ORIGIN="http://localhost:3000"
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=200
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=10
```

## Local Development
```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

## Security Hardening
- Helmet security headers enabled.
- CORS policy constrained by `CORS_ORIGIN`.
- Global rate limiting enabled (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`) plus stricter auth endpoint limiter.
- Request body limit set to 1 MB.
- Environment validation at startup (fail-fast on missing/invalid secrets).
- Refresh tokens stored hashed in database.
- Graceful shutdown hooks for SIGTERM/SIGINT.

## Deployment Guide

### 1) Infrastructure Preparation
- Provision a PostgreSQL instance (managed or self-hosted).
- Create a dedicated database user with least-privilege access to the target DB.
- Prepare runtime environment variables (`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `RATE_LIMIT_*`).

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
curl http://<HOST>:<PORT>/ready
```
Expected responses:
```json
{ "success": true, "data": { "status": "ok", "env": "production" } }
{ "success": true, "data": { "status": "ready" } }
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
