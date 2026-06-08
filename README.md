# Morneven Backend

Morneven Backend is the stable API, database, realtime, storage, security, extraction, backup, migration, and Bot Manager integration service for the Morneven platform.

The canonical documentation lives in the shared workspace `Document/` folder.

## Repository Role

`morneven-backend` is responsible for:

- Express API under `/api` and `/v1`.
- JWT auth, refresh sessions, account status, and security sessions.
- Personnel role and PL authority enforcement.
- PostgreSQL persistence through Prisma.
- Content APIs for projects, lore, gallery, news, map, management, chat, notifications, activity, and command center.
- Authenticated object storage proxy and uploads.
- Storage cleanup, extraction, full backup, backup restore, and migration.
- Security module, rate limits, audit logs, blocks, sessions, and file scan records.
- WebSocket realtime events.
- Bot Manager data model, credentials, identities, files, backups, and Nanobot runtime sync.

Backend authorization is the source of truth. Frontend visibility is not a security boundary.

## Related Repositories

| Repository | Relationship |
| --- | --- |
| `morneven-website` | Consumes backend REST APIs, websocket events, and media proxy URLs |
| `morneven-backend` | Owns data, auth, storage, security, migration, extraction, backup, and Bot Manager source of truth |
| `morneven_nanobot` | Pulls Bot Manager runtime bundles from backend and exposes runtime control endpoints |

## Core Modules

| Module | Purpose |
| --- | --- |
| `auth` | Login, register, guest, refresh, logout, password reset |
| `me` | Current user account snapshot |
| `projects` | Project records, patches, docs, metadata |
| `lore` | Characters, creatures, places, technology, events, other lore, docs, discussion |
| `gallery` | Gallery media, tags, reactions, publisher identity |
| `map` | Map image and markers |
| `personnel` | Personnel list, lookup, create, update, status, moderation |
| `settings` | Presets, extraction, backup, migration, storage cleanup, chat reset, reports |
| `news` | News feed and attachments |
| `files` | Upload and object proxy |
| `management` | Personnel workflow requests |
| `notifications` | Notification records and read state |
| `chat` | Conversations, members, messages, attachments, realtime chat state |
| `content-stats` | Views, likes, dislikes, stars, reactions |
| `activity` | Visitor and content analytics |
| `command-center` | Global command center settings |
| `security` | Security events, blocks, sessions, file scans |
| `bot-manager` | Bot Manager credentials, personalities, files, backups, runtime sync |

## Runtime Requirements

- Node.js 24 or newer.
- npm 10 or newer.
- PostgreSQL.
- Prisma migrations.
- Storage driver: local, S3-compatible, or GCS-compatible.

## Environment

Create `.env` from `.env.example` and fill production-safe values.

Important groups:

- Core: `DATABASE_URL`, `PORT`, `NODE_ENV`, `CORS_ORIGIN`.
- Auth: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AUTH_COOKIE_ENABLED`, `AUTH_COOKIE_DOMAIN`.
- Rate limits: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`.
- Security: `SECURITY_LEVEL`, `SECURITY_BLOCK_TTL_MS`, `SECURITY_RETENTION_DAYS`, `SECURITY_HASH_PEPPER`, `FILE_SCAN_PROVIDER`.
- Storage: `STORAGE_DRIVER`, local storage vars, S3 vars, or GCS vars.
- Upload: `MAX_UPLOAD_MB`.
- Extraction and migration: `EXTRACTION_KEY`, `MIGRATION_KEY`.
- Bot Manager: `BOT_MANAGER_KEY`, `BOT_MANAGER_ENCRYPTION_KEY`, `BOT_MANAGER_SYNC_TOKEN`, `NANOBOT_INTERNAL_BASE_URL`, `NANOBOT_MORNEVEN_RELOAD_TOKEN`.
- Bot Manager legacy runtime import: set `NANOBOT_LEGACY_INTERNAL_BASE_URL` to the old Nanobot service while `NANOBOT_INTERNAL_BASE_URL` points to ZeroClaw. `NANOBOT_LEGACY_MORNEVEN_RELOAD_TOKEN` is optional and falls back to `NANOBOT_MORNEVEN_RELOAD_TOKEN`.

## Development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

Validation:

```bash
npm run build
npx prisma validate
```

## Deployment

Recommended production deployment flow:

```bash
npm ci
npm run prisma:generate
npm run build
npm run prisma:migrate:deploy
npm run start
```

Railway deployment uses:

```bash
npm run start:railway
```

Production requirements:

- `NODE_ENV=production`.
- Strong JWT secrets.
- Correct CORS origin.
- Prisma migrations applied.
- Persistent storage or object storage configured.
- Health checks passing.
- Backup and migration keys set before operational use.

Health endpoints:

```text
/health
/ready
/version
/api/health
/api/ready
/api/version
/v1/health
/v1/ready
/v1/version
```

## Data Operations

Extraction and backup can export:

- Database JSON snapshot.
- SQL dump.
- Attachment manifest.
- Media files.
- Backup README wiring instructions.

Migration supports:

- Live backend payload to clone backend.
- Custom migration endpoint.
- Restore from backup ZIP into the current backend.

Storage cleanup scans storage objects against database references. Bot Manager backup coverage includes the full `bot-manager/` storage prefix.

## Security

The security module includes:

- Helmet and CORS.
- Global and route-group rate limits.
- Security sessions.
- Temporary blocks.
- Security event history.
- File scan records.
- Upload validation.
- History cleanup per section.

`SECURITY_LEVEL` ranges from `0` to `5`, where `0` disables the module and `5` enables the full configured posture.

## Documentation

Active shared documentation:

- [Platform Architecture](../Document/Documentation/General/2026-05-29-platform-architecture-v02.md)
- [Backend API Contract](../Document/Documentation/Backend/root-docs/2026-05-29-backend-api-contract-v02.md)
- [Website Feature Documentation](../Document/Documentation/Website/docs/2026-05-29-website-feature-documentation-v02.md)
- [Website Guidebook](../Document/Guide/Website/docs/2026-05-29-website-guidebook-v02.md)
- [Bot Manager Guide](../Document/Guide/General/2026-05-29-bot-manager-guide-v02.md)
- [Document Index](../Document/Documentation/General/2026-05-29-document-index-v03.md)

When API, schema, extraction, migration, backup, security, or Bot Manager behavior changes, update the active `Document/` docs with the code change.

## License

Copyright (c) 2026 madan6557.

No license is granted to use, copy, modify, or distribute this repository's contents without explicit written permission from the owner.
