# Backend REST API Requirement — Morneven Institute Platform

**Product:** Morneven Institute Website  
**Module Scope:** Full platform (Lore/Wiki, Projects, Gallery, News, Map, Personnel, Management, Notifications, Auth, Chat)  
**Last updated:** 2026-04-29  
**Status:** Implementation contract for backend developer  
**Companion docs:**
- `production-readiness-chat-plan.md` — Chat module deep-dive and phased production roadmap
- `docs/backend-requirements-full-platform-2026-04-27.md` — earlier draft, superseded for non-chat modules

---

## 0. Purpose & Reading Order

This document is the **single source of truth** that BE must implement to fully replace the current frontend localStorage-backed services without UI changes.

For each module the doc lists:
1. **Data model** (DB tables + columns).
2. **REST endpoints** (verb, path, body, query, response).
3. **Authorization** (who can call).
4. **Side effects** (cascades, syncs, notifications).
5. **Validation & error contract**.

Frontend service files this contract mirrors 1:1 (one file per module):

| Module | FE service file |
|---|---|
| Auth | `src/contexts/AuthContext.tsx` |
| Personnel | `src/services/personnelApi.ts` |
| Lore — characters/places/tech/creatures/other | `src/services/loreApi.ts` |
| Lore — events | `src/services/eventsApi.ts` |
| Projects | `src/services/projectsApi.ts` |
| Discussions (per-entity comments) | `src/services/discussionApi.ts` |
| Gallery | `src/services/galleryApi.ts` |
| News | `src/services/newsApi.ts` |
| Map | `src/services/mapApi.ts` |
| Management workflows | `src/services/managementApi.ts` |
| Notifications | `src/services/notificationsApi.ts` |
| Chat | `src/services/chatApi.ts` (see `BERequierment.md`) |

---

## 1. Conventions

### 1.1 Base URL
```
https://api.morneven.example.com/v1
```

### 1.2 Transport
- HTTPS only. TLS 1.2+.
- `Content-Type: application/json; charset=utf-8` for all non-upload requests.
- File uploads: `multipart/form-data` OR presigned PUT to object storage.

### 1.3 Auth header
```
Authorization: Bearer <jwt>
```
JWT claims required: `sub` (user id), `username`, `role`, `level` (0-7), `track`, `iat`, `exp`.

### 1.4 IDs
- All primary keys: `string` (UUIDv4 in DB, stringified in API).
- FE currently uses prefixed timestamp ids (e.g. `proj-1714...`). BE may switch to UUID; FE only assumes "string".

### 1.5 Timestamps
- All datetime fields: ISO-8601 UTC (`2026-04-29T13:45:21Z`).
- Date-only fields (e.g. `news.date`, `meta.startedAt`): `YYYY-MM-DD`.

### 1.6 Pagination
Default for any list endpoint that may exceed 100 rows:
```
GET /resource?page=1&pageSize=50&sort=-createdAt&q=<search>
```
Response envelope:
```json
{ "data": [...], "page": 1, "pageSize": 50, "total": 312 }
```
For small fixed lists (e.g. lore — ~80 rows total today) BE MAY return a bare array; FE accepts both.

### 1.7 Error contract
HTTP status + JSON body:
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable summary",
    "fields": { "title": "Required" }
  }
}
```
Standard codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `VALIDATION_FAILED` (422), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL` (500).

### 1.8 Idempotency
`POST` create endpoints SHOULD honor `Idempotency-Key` header (24h window).

### 1.9 Realtime
Where the FE listens to a `morneven:*-changed` window event, BE must emit an equivalent WebSocket event on a per-user channel:
```
wss://api.morneven.example.com/v1/ws?token=<jwt>
```
Event envelope:
```json
{ "type": "notification.created", "payload": { ... } }
```

---

## 2. Authorization model (PL = Personnel Level)

Source of truth: `src/lib/pl.ts`. PL is on the JWT and on the `personnel` row.

| PL | Label | Track-aware | Notes |
|---|---|---|---|
| 0 | Guest | no | Public read of non-restricted lore |
| 1 | Intern | yes | Default for new registrations |
| 2 | Operative | yes | Personal submissions (monthly quota = 1) |
| 3 | Team Leader | yes | Team projects (yearly quota = 1) |
| 4 | Supervisor | yes | Reviews PL2/PL3 of same track. Supervision quota = 2/yr |
| 5 | Division Director | yes | Reviews track transfers (target track) |
| 6 | Board | no | Reviews executive promotions |
| 7 | Full Authority | no | Author / superuser. Bypasses all checks |

Tracks: `executive` (GOV), `field`, `mechanic`, `logistics`.

Roles (legacy auth role): `author` (=PL7), `personel`, `guest`. `role` MUST stay in sync with `level`:
- level 7 → role `author`
- level 1-6 → role `personel`
- level 0 → role `guest`

**Authorization helper used by FE** (`canDecideRequest`) is reproduced verbatim in §10.4. BE must enforce server-side.

---

## 3. Authentication Module

### 3.1 Tables

```sql
-- Auth identity (separate from personnel profile so identity providers can swap)
create table auth_users (
  id            uuid primary key default gen_random_uuid(),
  email         citext unique not null,
  password_hash text not null,           -- argon2id
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- One row per personnel; FK to auth_users
create table personnel (
  id          uuid primary key default gen_random_uuid(),
  auth_id     uuid unique references auth_users(id) on delete cascade,
  username    citext unique not null,
  email       citext not null,           -- denormalized
  role        text not null check (role in ('author','personel','guest')),
  level       smallint not null check (level between 0 and 7),
  track       text not null check (track in ('executive','field','mechanic','logistics')),
  note        text,
  updated_at  date not null default current_date
);
create index on personnel(track, level);
```

### 3.2 Endpoints

| Verb | Path | Body | Auth | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password, username }` | public | Creates auth_user + personnel(level=1, track='executive'). Returns JWT. |
| POST | `/auth/login` | `{ email, password }` | public | Returns JWT + personnel snapshot. |
| POST | `/auth/guest` | `{}` | public | Issues short-lived guest JWT (level=0, role='guest'). |
| POST | `/auth/logout` | — | bearer | Revokes refresh token. |
| GET | `/auth/me` | — | bearer | Returns current personnel + clearance. |
| POST | `/auth/refresh` | `{ refreshToken }` | public | Rotates JWT. |

**Login response shape** (matches `AuthContext.login` consumption):
```json
{
  "token": "eyJ...",
  "refreshToken": "...",
  "user": {
    "id": "uuid",
    "username": "h.kato",
    "email": "h.kato@morneven.com",
    "role": "personel",
    "level": 2,
    "track": "field"
  }
}
```

### 3.3 Side effects on register
1. Insert personnel row with level=1, track='executive'.
2. Add to institute-wide chat conversation (see §11).
3. Push welcome notification.

---

## 4. Personnel Module

Mirrors `src/services/personnelApi.ts`.

### 4.1 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/personnel` | PL≥4 | List all. Supports `?track=field&level=2&q=name`. |
| GET | `/personnel/:id` | PL≥4 OR self | Single record. |
| POST | `/personnel` | PL≥6 | Manual create (admin tool). |
| PUT | `/personnel/:id` | PL≥5 (same track) OR PL≥6 | Patch fields. Sets `updated_at = today`. |
| PATCH | `/personnel/bulk` | PL≥6 | `{ ids:[], patch:{} }`. Returns updated rows. |
| DELETE | `/personnel/:id` | PL≥7 | Soft-delete preferred. |

### 4.2 Validation
- `level` must be 0..7. PL7 may only be set by another PL7.
- Demoting a team leader (PL3) cascades: clear `teams.leader` and require reassignment.
- Track change cascades: re-sync chat division membership (§11).

---

## 5. Lore Module (shared shape for Characters, Places, Technology, Creatures, Other)

All five entities share CRUD shape + per-entity discussion threads. Difference is only the table & columns (see `src/types/index.ts`).

### 5.1 Common columns on every lore table

```sql
id           uuid primary key
thumbnail    text
short_desc   text not null
full_desc    text not null
docs         jsonb not null default '[]'   -- DocItem[]
discussions  jsonb not null default '[]'   -- DiscussionComment[]  (see §7)
contributor  citext                          -- username
meta         jsonb                          -- LoreMeta (see §5.2)
created_at   timestamptz not null default now()
updated_at   timestamptz not null default now()
```

### 5.2 LoreMeta shape (jsonb)
```ts
{
  creator?: string;
  owner?: string;
  designer?: string;
  collaborators?: string[];
  team?: string;
  projectName?: string;
  startedAt?: string;     // YYYY-MM-DD
  completedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  patchNotes?: { version: string; date: string; notes: string }[];
  license?: string;
  sourceUrl?: string;
}
```

### 5.3 Per-entity columns

| Entity | Table | Extra columns |
|---|---|---|
| Character | `lore_characters` | `name`, `race`, `occupation`, `height`, `traits text[]`, `likes text[]`, `dislikes text[]`, `accent_color`, `stats jsonb` (combat/intelligence/stealth/charisma/endurance), `contributions jsonb` |
| Place | `lore_places` | `name`, `type` |
| Technology | `lore_technology` | `name`, `category` |
| Creature | `lore_creatures` | `name`, `classification` (enum), `danger_level smallint 1-5`, `habitat`, `accent_color` |
| Other | `lore_other` | `title`, `category` |
| Event | `lore_events` | `title`, `category`, `era`, `date_label`, `scope`, `impact_level`, `consequences text[]`, `related_links jsonb` |

### 5.4 Endpoints (apply for each `{resource}` ∈ characters, places, technology, creatures, other, events)

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/lore/{resource}` | public (PL≥0) | List. Supports `?q=&category=&page=&pageSize=`. |
| GET | `/lore/{resource}/:id` | public | Detail. |
| POST | `/lore/{resource}` | PL≥4 OR via Submission flow (§10) | Authoring. |
| PUT | `/lore/{resource}/:id` | author (contributor) OR PL≥5 | Partial update. |
| DELETE | `/lore/{resource}/:id` | PL≥6 | Hard delete OR soft-archive. |

### 5.5 Side effects
- Update bumps `updated_at`. If `meta.patchNotes` grows, the most recent entry SHOULD have `date <= today`.
- Creating via Management Submission flow auto-fills `contributor` = requester.

---

## 6. Projects Module

Mirrors `src/services/projectsApi.ts`. Shape: `Project` interface in `src/types/index.ts`.

### 6.1 Table
```sql
create table projects (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  status       text not null check (status in ('Planning','On Progress','On Hold','Completed','Canceled')),
  thumbnail    text,
  short_desc   text not null,
  full_desc    text not null,
  patches      jsonb not null default '[]',   -- ProjectPatch[]
  docs         jsonb not null default '[]',   -- DocItem[]
  archived     boolean not null default false,
  contributor  citext,
  meta         jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on projects(status) where archived = false;
```

### 6.2 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/projects` | public | `?status=&archived=false&q=&page=&pageSize=` |
| GET | `/projects/:id` | public | |
| POST | `/projects` | PL≥4 OR via Team Submission flow | |
| PUT | `/projects/:id` | contributor OR PL≥5 | |
| POST | `/projects/:id/archive` | PL≥6 | Sets `archived=true`. |
| DELETE | `/projects/:id` | PL≥7 | |

---

## 7. Discussions (per-entity comment threads)

Mirrors `src/services/discussionApi.ts`. All lore entities + events share this surface.

### 7.1 Embedded model (recommended)
Stored as `discussions jsonb` on each lore row:
```ts
DiscussionComment {
  id: string;
  author: string;
  text: string;
  date: string;         // YYYY-MM-DD
  mentions?: { username, start, end }[];
  replies: DiscussionReply[];
}
```
BE MAY normalize to a separate `discussion_comments` table; if so, expose the same JSON shape on read.

### 7.2 Endpoints
For each lore type `{type}` ∈ `places|technology|other|characters|creatures|events`:

| Verb | Path | Auth | Body |
|---|---|---|---|
| POST | `/lore/{type}/:id/comments` | PL≥1 | `{ text, mentions[] }` |
| PUT | `/lore/{type}/:id/comments/:commentId` | author OR PL≥4 | `{ text, mentions[] }` |
| DELETE | `/lore/{type}/:id/comments/:commentId` | author OR PL≥4 | — |
| POST | `/lore/{type}/:id/comments/:commentId/replies` | PL≥1 | `{ text, mentions[] }` |
| PUT | `/lore/{type}/:id/comments/:commentId/replies/:replyId` | author OR PL≥4 | `{ text, mentions[] }` |
| DELETE | `/lore/{type}/:id/comments/:commentId/replies/:replyId` | author OR PL≥4 | — |

All return the **full updated parent entity** (matches FE behavior).

### 7.3 Mention side effect
When `mentions[]` is non-empty, push a `kind:"mention"` notification to each mentioned `username` with `link` = canonical entity URL (e.g. `/lore/characters/:id`).

---

## 8. Gallery Module

Mirrors `src/services/galleryApi.ts`.

### 8.1 Table
```sql
create table gallery_items (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('image','video')),
  title       text not null,
  thumbnail   text not null,
  video_url   text,
  caption     text,
  tags        text[] not null default '{}',
  date        date not null default current_date,
  comments    jsonb not null default '[]',  -- GalleryComment[]
  uploaded_by citext,                          -- username
  created_at  timestamptz not null default now()
);
create index on gallery_items using gin (tags);
```

### 8.2 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/gallery` | public | `?tag=&type=&q=&page=` |
| GET | `/gallery/:id` | public | |
| POST | `/gallery` | PL≥4 OR via Personal Submission flow | |
| PUT | `/gallery/:id` | uploader (PL6) OR PL≥7 | PL6 may only edit own uploads |
| DELETE | `/gallery/:id` | uploader (PL6) OR PL≥7 | Same scope rule |
| POST | `/gallery/:id/comments` | PL≥1 | `{ author, text, mentions[] }` |
| POST | `/gallery/:id/comments/:cid/replies` | PL≥1 | `{ author, text, mentions[] }` |

### 8.3 Uploads
Two-step:
1. `POST /uploads/sign` → `{ url, fields, key }` (S3 presigned PUT).
2. Client PUTs binary, then sends `key` as `thumbnail`/`videoUrl`.

Max image: 8 MB. Max video: 200 MB. Allowed mimes: `image/png|jpeg|webp|gif`, `video/mp4|webm`.

---

## 9. News Module

Mirrors `src/services/newsApi.ts`.

### 9.1 Table
```sql
create table news_items (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,             -- headline
  date        date not null default current_date,
  body        text,
  thumbnail   text,
  attachments jsonb not null default '[]',  -- NewsAttachment[]
  has_detail  boolean not null default false,
  created_at  timestamptz not null default now()
);
```

### 9.2 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/news` | public | Sorted DESC by `date`. |
| GET | `/news/:id` | public | 404 unless `has_detail`. |
| POST | `/news` | PL≥5 | |
| PUT | `/news/:id` | PL≥5 | |
| DELETE | `/news/:id` | PL≥6 | |

### 9.3 Side effect
On create, broadcast `notification` (kind `system`, recipient `*`) when `has_detail=true`.

---

## 10. Map Module

Mirrors `src/services/mapApi.ts`.

### 10.1 Tables
```sql
create table map_image (
  id        smallint primary key default 1,
  image_url text not null,
  updated_at timestamptz not null default now()
);

create table map_markers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null check (status in ('safe','caution','danger','restricted','mission')),
  x           numeric(6,5) not null,   -- 0..1
  y           numeric(6,5) not null,
  description text,
  lore_link   text
);
```

### 10.2 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/map/image` | public | `{ url }` |
| PUT | `/map/image` | PL≥6 | `{ url }` |
| GET | `/map/markers` | public | Markers w/ `status='restricted'` only visible to PL≥4 |
| PUT | `/map/markers` | PL≥4 | Bulk replace. Body: full array. Returns saved array. |

---

## 11. Management Workflows

Mirrors `src/services/managementApi.ts`. This is the most authorization-sensitive module.

### 11.1 Tables
```sql
create type request_kind as enum (
  'transfer','clearance',
  'submission_personal','submission_team',
  'team_change','executive_promotion'
);
create type request_status as enum ('pending','approved','rejected');

create table mgmt_requests (
  id               uuid primary key default gen_random_uuid(),
  kind             request_kind not null,
  requester        citext not null,
  requester_track  text not null,
  requester_level  smallint not null,
  payload          jsonb not null,
  reason           text not null,
  status           request_status not null default 'pending',
  reviewer         citext,
  review_note      text,
  created_at       date not null default current_date,
  decided_at       date
);
create index on mgmt_requests(status, kind);

create table mgmt_teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  leader      citext not null,
  members     citext[] not null default '{}',
  track       text not null,
  created_at  date not null default current_date,
  cycle_year  smallint not null,
  completed   smallint not null default 0
);

create table mgmt_quotas (
  username    citext primary key,
  monthly     jsonb not null default '{}',  -- { "2026-04": 1 }
  yearly      jsonb not null default '{}',  -- { "2026": 1 }
  supervised  jsonb not null default '{}'   -- { "2026": 2 }
);
```

### 11.2 Endpoints — Requests

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/mgmt/requests` | PL≥4 | `?kind=&status=&requester=` |
| POST | `/mgmt/requests` | PL≥1 | Self-create only (`requester` from JWT). |
| POST | `/mgmt/requests/:id/decide` | per §11.4 | `{ decision: 'approved'\|'rejected', reviewNote? }` |

### 11.3 Endpoints — Teams & Quotas

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/mgmt/teams` | PL≥3 | `?leader=&member=` |
| POST | `/mgmt/teams` | PL≥4 | Side effect: auto chat group. |
| GET | `/mgmt/quotas/:username` | self OR PL≥4 | Returns full QuotaRecord + computed pl2/pl3/pl4 status. |

### 11.4 Authorization for `decide`
Server-side replica of `canDecideRequest`:
```
deny if request.status != 'pending'
deny if reviewer.username == request.requester
allow if reviewer.level >= 7
switch request.kind:
  executive_promotion: allow if reviewer.level >= 6
  transfer:            allow if reviewer.level >= 5 AND reviewer.track == payload.targetTrack
  clearance,
  submission_personal,
  submission_team,
  team_change:         allow if reviewer.level >= 4 AND reviewer.track == request.requester_track
deny otherwise
```

### 11.5 Side effects on approval

| kind | Effect |
|---|---|
| `transfer` | `personnel.track = payload.targetTrack`. Re-sync chat division membership. Push `system` notif to requester. |
| `clearance` | `personnel.level = payload.targetLevel`. Push notif. |
| `submission_personal` | Insert `gallery_items` from `payload.item` with `uploaded_by=requester`. Bump quota.monthly[currentMonth]. Push notif w/ link `/gallery`. |
| `submission_team` | Insert `projects` from `payload.project` with `contributor=requester`. Bump quota.yearly. Bump reviewer's `quota.supervised`. Push notif w/ link `/projects`. |
| `team_change` | Add/remove from `mgmt_teams.members`. Re-sync team chat group. |
| `executive_promotion` | `personnel.level = 5`. Push notif. |

All side effects MUST run in one DB transaction together with the request status update. Notification dispatch can be after-commit (best effort).

### 11.6 Quota rules
- PL2 monthly target = 1 personal submission.
- PL3 yearly target = 1 team project.
- PL4 yearly supervision target = 2 approvals.

Helpers `pl2Status / pl3Status / pl4Status` (FE) MUST be reproduced server-side and exposed via `GET /mgmt/quotas/:username` response:
```json
{
  "monthly": { "2026-04": 1 },
  "yearly":  { "2026": 0 },
  "supervised": { "2026": 1 },
  "pl2": { "met": true,  "count": 1 },
  "pl3": { "met": false, "count": 0 },
  "pl4": { "met": false, "count": 1, "target": 2 }
}
```

---

## 12. Notifications Module

Mirrors `src/services/notificationsApi.ts`.

### 12.1 Table
```sql
create type notification_kind as enum ('info','warning','system','mention','request');

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  kind       notification_kind not null,
  title      text not null,
  body       text,
  recipient  citext not null,           -- username, or '*' for broadcast
  sender     citext,
  link       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index on notifications(recipient, read, created_at desc);
```

### 12.2 Endpoints

| Verb | Path | Auth | Notes |
|---|---|---|---|
| GET | `/notifications` | self | Returns rows where `recipient = me OR recipient='*'`. Sorted desc. |
| GET | `/notifications/unread-count` | self | `{ count }` |
| POST | `/notifications` | PL≥7 OR system | Manual push (warnings, broadcasts). |
| POST | `/notifications/:id/read` | recipient | |
| POST | `/notifications/read-all` | self | |
| DELETE | `/notifications` | self | Clear all for self. |

### 12.3 Realtime
Push WS event `notification.created` to recipient(s) on insert.

---

## 13. Chat Module

Already specified in detail in `BERequierment.md`. This document references it for completeness.

Key cross-module hooks BE must wire:
- `personnel.track` change → call `syncDivisionMembership(username, newTrack)` equivalent.
- `mgmt_teams` insert/update → call `syncTeamGroup(teamId, name, members)` equivalent.
- New personnel registration → join `institute` conversation.

---

## 14. File Uploads (shared)

All modules with images/videos (Lore, Projects, Gallery, News, Map, Chat attachments) use the same upload service.

| Verb | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/uploads/sign` | PL≥1 | `{ filename, mimeType, size, scope: 'gallery'\|'lore'\|...}` | `{ uploadUrl, key, publicUrl, expiresAt }` |
| POST | `/uploads/confirm` | PL≥1 | `{ key }` | `{ url }` (if processing/thumbnailing applies) |

Storage: S3-compatible. Public read for `gallery|lore|news|map`. Private (signed URL) for `chat` attachments.

---

## 15. Search (optional, phase 2)

`GET /search?q=...&types=characters,places,projects,events` returns:
```json
{
  "results": [
    { "type": "character", "id": "uuid", "title": "...", "snippet": "...", "url": "/lore/characters/uuid" }
  ]
}
```
Backed by Postgres full-text or Meilisearch.

---

## 16. Migration from current FE storage

| FE localStorage key | BE table | Migration |
|---|---|---|
| `morneven_projects` | `projects` | Bulk insert from `src/data/projects.json` seed. |
| `morneven_characters` | `lore_characters` | from `src/data/characters.json` |
| `morneven_places` | `lore_places` | from `src/data/places.json` |
| `morneven_technology` | `lore_technology` | from `src/data/technology.json` |
| `morneven_creatures` | `lore_creatures` | from `src/data/creatures.json` |
| `morneven_other` | `lore_other` | from `src/data/other.json` |
| `morneven_events` | `lore_events` | from `src/data/events.json` |
| `morneven_gallery` | `gallery_items` | from `src/data/gallery.json` |
| `morneven_news` | `news_items` | from `src/data/news.json` |
| `morneven_map_markers` + `morneven_map_image` | `map_markers`, `map_image` | from `src/data/map.json` |
| `morneven_personnel` | `personnel` | from `src/data/personnel.json` |
| `morneven_mgmt_requests/teams/quotas` | `mgmt_*` | empty seed allowed (FE re-seeds demo) |
| `morneven_notifications` | `notifications` | empty |
| `morneven_chat_*_v2` | chat tables | see `BERequierment.md` |

Provide one-shot importer script: `npm run seed:import -- --file <json>` per resource.

---

## 17. Acceptance Criteria

A backend release is "done" when, for every module:

1. **CRUD parity** — every FE service function has a matching endpoint that returns the same shape.
2. **Authorization** — PL/track checks enforced server-side; an authenticated PL1 cannot mutate other users' data.
3. **Cascades** — track transfer reflects in chat membership within 2 s; team change reflects in team chat roster.
4. **Quotas** — quota counters increment exactly once per approval and never on rejection.
5. **Realtime** — WS event for `notification.created`, `chat.message.created`, `mgmt.request.decided` reaches the affected user within 1 s under nominal load.
6. **Validation** — invalid payloads return 422 with field map (not 500).
7. **Audit** — every `mgmt_requests.decide` and every PL change writes to an `audit_log` table with `actor`, `action`, `target`, `before`, `after`, `at`.
8. **No data loss on FE swap** — migrating a power-user account preserves all their lore contributions, gallery uploads, projects, requests, and unread notifications.

---

## 18. Audit log (required for §17.7)

```sql
create table audit_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  actor     citext not null,         -- username or 'system'
  action    text not null,           -- e.g. 'request.decide', 'personnel.update'
  target    text,                    -- resource id
  before    jsonb,
  after     jsonb,
  ip        inet,
  user_agent text
);
create index on audit_log(actor, at desc);
create index on audit_log(action, at desc);
```

Trigger-write on:
- any `personnel` UPDATE
- any `mgmt_requests` UPDATE that flips `status`
- any `projects` / lore DELETE
- any notification with `kind='warning'`

---

## 19. Rate limits (recommended)

| Scope | Limit |
|---|---|
| `/auth/login` | 10 / minute / IP |
| `/auth/register` | 5 / hour / IP |
| `POST /lore/*/comments` | 30 / minute / user |
| `POST /chat/messages` | 60 / minute / user |
| `POST /uploads/sign` | 30 / minute / user |
| anything else | 600 / minute / user |

Return `429` with `Retry-After` header.

---

## 20. Out of scope (this contract)

- Email delivery (only `notifications` table; SMTP integration is separate work).
- Payment / billing.
- E2EE chat.
- Multi-region active-active.
- Push notifications (mobile).
- SSO / OAuth providers (only email+password covered in §3).

---

**End of document.** Cross-reference `BERequierment.md` for chat-specific details (real-time fan-out, attachment lifecycle, system-managed conversations, audit hooks).
