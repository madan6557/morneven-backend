# Railway Deployment Notes

Last updated: 2026-05-01

This backend is prepared for a Railway project with two services:

- Backend service: Node.js API from this repository.
- PostgreSQL service: Railway PostgreSQL database.

## 1. Railway Services

Create or reuse these services in one Railway project:

| Service | Purpose | Notes |
|---|---|---|
| Backend | Express API | Deploy from `morneven-backend`. |
| PostgreSQL | Primary database | Use Railway PostgreSQL template or existing Postgres service. |

Railway PostgreSQL exposes `DATABASE_URL` to other services in the same project. In the backend service variables, set:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If your database service has a different name, replace `Postgres` with that service name.

## 2. Backend Build And Start

`railway.json` is configured for Nixpacks:

```json
{
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "startCommand": "npm run start:railway",
    "healthcheckPath": "/health"
  }
}
```

The Railway start command runs:

```text
npm run prisma:migrate:deploy && node dist/src/server.js
```

If migrations fail, the app should not start. This is intentional for staging and production safety.

## 3. Required Variables

Set these in the Backend service Variables tab:

```text
NODE_ENV=production
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_ACCESS_SECRET=<32+ char random secret>
JWT_REFRESH_SECRET=<32+ char random secret>
CORS_ORIGIN=https://<frontend-domain>
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=1200
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=100
MAX_UPLOAD_MB=20
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=/data/storage
LOCAL_STORAGE_BASE_PATH=/storage
```

Use comma-separated `CORS_ORIGIN` values if staging and production frontends both need access:

```text
CORS_ORIGIN=https://staging.example.com,https://www.example.com
```

## 4. Upload Storage

The API supports `local`, `gcs`, and `s3` storage drivers.

### Option A: Railway volume with local storage

Use this only if you attach a persistent volume to the Backend service.

Recommended variables:

```text
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=/data/storage
LOCAL_STORAGE_BASE_PATH=/storage
```

Attach the Railway volume to the Backend service at:

```text
/data
```

Without a volume, uploaded media and extraction ZIP files can be lost on redeploy.

### Option B: S3 compatible storage

Use this for production media durability.

```text
STORAGE_DRIVER=s3
S3_BUCKET_NAME=<bucket>
S3_REGION=<region>
S3_ENDPOINT=<endpoint if compatible provider>
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_PUBLIC_BASE_URL=<public base url if available>
S3_FORCE_PATH_STYLE=false
```

### Option C: Google Cloud Storage

```text
STORAGE_DRIVER=gcs
GCS_BUCKET_NAME=<bucket>
GCS_PROJECT_ID=<project id>
GCS_PUBLIC_BASE_URL=<optional public base url>
```

## 5. First Deploy Sequence

1. Deploy PostgreSQL service.
2. Deploy Backend service from `morneven-backend`.
3. Add required Backend variables.
4. Confirm deployment logs show `prisma migrate deploy` success.
5. Open:

```text
https://<backend-domain>/health
https://<backend-domain>/ready
```

Expected responses:

```json
{ "success": true, "data": { "status": "ok", "env": "production" } }
```

```json
{ "success": true, "data": { "status": "ready" } }
```

## 6. Seeding Staging Data

Run seed only for staging or demo databases. Do not seed over production user data.

From Railway CLI, after linking the Backend service:

```bash
railway run npm run prisma:seed
```

Seed account password:

```text
SeedPassword123
```

Production must rotate or disable seeded credentials before launch.

## 7. FE Integration Variables

Frontend should point to the Railway backend public domain:

```text
VITE_API_BASE_URL=https://<backend-domain>/api
```

Keep `/api` as the primary base path. `/v1` is also mounted for migration compatibility.

## 8. Verification Checklist

Before switching FE services from localStorage to REST:

- `npm run build` passes locally or in CI.
- `npm run prisma:generate` passes.
- Railway deployment logs show migration success.
- `/health` returns 200.
- `/ready` returns 200.
- Register returns `token`, `refreshToken`, and `user`.
- Login, refresh, logout, and validate-token pass.
- Gallery and Lore list endpoints return bounded paginated payloads.
- Events load from `/api/lore/events`.
- Command Center settings include all FE flags.
- Sidebar badges load from `/api/me/navigation-badges` or `/v1/me/navigation-badges`.
- Management request create, decide, teams, and quotas smoke tests pass.
- Notifications list, unread count, read, read-all, and clear-all pass.
- Chat DM, group invite, message send, read state, and unread count smoke tests pass.
- Chat realtime connects to `/ws/chat` with a bearer token or `?token=<access_token>`.
- FE can fall back to polling `/chat/conversations`, `/chat/conversations/:id/messages`, `/chat/unread-counts`, and `/me/navigation-badges`.
- PL7 extraction creates a ZIP job and download route works.
- PL7 extraction returns `processing` immediately and updates `progress` through `GET /settings/extractions/:id`.
- Uploads persist after redeploy if using local storage.

## 9. Operational Notes

- Do not set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to sample values.
- Recommended production launch rate limits are `RATE_LIMIT_WINDOW_MS=900000`, `RATE_LIMIT_MAX=1200`, `AUTH_RATE_LIMIT_WINDOW_MS=900000`, and `AUTH_RATE_LIMIT_MAX=100`.
- This balanced profile matches the staging values that passed R4 and leaves headroom for protected file proxy, responsive image loading, chat, and token refresh traffic.
- If abuse appears after launch, tighten to `RATE_LIMIT_MAX=600` and `AUTH_RATE_LIMIT_MAX=50` only after confirming normal users are not hitting `429`.
- Keep auth rate limiting stricter than global API limiting in production.
- Use a persistent storage driver before enabling uploads for real users.
- Back up PostgreSQL before running seed or destructive maintenance commands.
- Treat a passing Railway deploy as smoke status only. Functional QA must still run with the frontend connected to this backend.
