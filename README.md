# Morneven Backend

Morneven Backend is the source of truth for authentication, authorization,
PostgreSQL data, object storage, realtime events, security controls, backup,
restore, scheduled tasks, and ZeroClaw Bot Manager integration.

## Responsibilities

- Express APIs under `/api` and `/v1`.
- JWT access and refresh sessions.
- Personnel roles and PL authority enforcement.
- PostgreSQL persistence through Prisma.
- Authenticated uploads and validated storage object delivery.
- Security events, file scan records, rate limits, and audit logs.
- WebSocket realtime updates.
- Durable extraction and backup jobs.
- Persistent scheduled backup and runtime tasks.
- ZeroClaw runtime bundle, identity, credential, and control state.

Frontend visibility is not a security boundary. Every privileged action is
validated by the backend.

## Requirements

- Node.js 24 or newer.
- npm 10 or newer.
- PostgreSQL.
- Local, S3-compatible, or GCS-compatible object storage.

## Environment

Copy `.env.example` to `.env` and replace every placeholder. Important values:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=<unique secret>
JWT_REFRESH_SECRET=<unique secret>
CORS_ORIGIN=https://morneven.com
MIGRATION_KEY=<unique secret>
EXTRACTION_KEY=<unique secret>
BOT_MANAGER_KEY=<unique secret>
BOT_MANAGER_ENCRYPTION_KEY=<unique secret, minimum 32 characters>
BOT_MANAGER_SYNC_TOKEN=<same value as ZeroClaw MORNEVEN_BOT_MANAGER_SYNC_TOKEN>
ZEROCLAW_INTERNAL_BASE_URL=http://<zeroclaw-private-domain>:8080
ZEROCLAW_MORNEVEN_RELOAD_TOKEN=<same value as ZeroClaw MORNEVEN_RELOAD_TOKEN>
```

ZeroClaw uses the persistent mount:

```text
/zeroclaw-data/data
```

Its Morneven runtime root is:

```text
/zeroclaw-data/data/morneven
```

## Development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

Quality gate:

```bash
npm run build
npm test
npx prisma validate
npm audit
```

## Deployment

```bash
npm ci
npm run prisma:generate
npm run build
npm run prisma:migrate:deploy
npm run start
```

Railway can use:

```bash
npm run start:railway
```

The scheduler and extraction worker start with the API process. Database leases,
unique run keys, and idempotency keys make them safe across multiple backend
replicas.

## Scheduled Operations

PL7 Authors can manage:

- `GET/PUT/DELETE /api/settings/extraction/schedule`
- `GET/PUT/DELETE /api/bot-manager/identities/:id/runtime-schedule`
- `GET/PUT/DELETE /api/bot-manager/runtime-freeze`

Mutations require account password confirmation. Backup schedule mutations also
require `EXTRACTION_KEY`. Secrets are validated in memory and are not persisted
in task payloads.

Supported schedules:

- One-time local date and time.
- After 1 to 3650 days.
- Weekly selected weekdays and local time.
- IANA timezone per task.

## Backup Contract

Full archives use `morneven-zeroclaw-backup/v1`. They contain a checksum
manifest, backend datasets, storage objects, encrypted Bot Manager data,
ZeroClaw runtime bundle, schedule definitions, and runtime control state.

Restore validates ZIP safety, schema, file sizes, and SHA-256 before import.
Restored schedules are disabled and restored runtime state is stopped.

Default retention is three backups for seven days. Cleanup starts at 350 MiB.
A new backup is blocked at 450 MiB when cleanup cannot create enough space.

## Extraction Reliability

- Jobs are queued and claimed by a durable worker.
- Only one queued or processing job is allowed per Author.
- Duplicate create and retry requests are deduplicated.
- A processing job without progress heartbeat for 30 minutes becomes
  `stopped`.
- Partial artifacts are removed.
- Retry creates a new attempt starting at 0 percent.
- API timestamps are RFC3339 UTC values.

## Security

- Helmet, strict CORS, rate limits, and audit records.
- MIME allowlist plus file signature validation.
- Executables, archives, SVG, HTML, scripts, stylesheets, and active markup are
  blocked from normal uploads.
- Storage paths reject traversal, separators, and control characters.
- Storage is not exposed through `express.static`.
- Active or document content is forced to download with `nosniff`, framing
  denial, and sandboxed CSP headers.

See [guide.md](./guide.md) for deployment, hardening, backup, restore, scheduler,
storage, redeployment, and shutdown procedures.

## License

Copyright (c) 2026 madan6557.

No license is granted to use, copy, modify, or distribute this repository's
contents without explicit written permission from the owner.
