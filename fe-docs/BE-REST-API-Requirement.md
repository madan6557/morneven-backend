# Backend REST API Requirement - Morneven Institute Platform

**Product:** Morneven Institute Website  
**Frontend repository:** `morneven-website`
**Backend repository:** `morneven-backend`
**Last updated:** 2026-05-01  
**Latest FE alignment update:** 2026-05-01
**Backend implementation status update:** 2026-05-01
**Status:** Backend has been developed and deploy-smoke-tested only. No functional QA pass is recorded yet.
**Purpose:** Implementation contract for backend and frontend integration parity.

## 0. Update Log [Updated 2026-05-01]

| Date | Area | Update |
|---|---|---|
| 2026-05-01 | FE parity | Aligned this contract with `frontend-feature-validation-report-2026-05-01.md`. |
| 2026-05-01 | Deployment status | Documented current backend status as deploy-only, no QA. This must not be treated as production readiness. |
| 2026-05-01 | Response contract | Updated response requirements to match current backend envelope: `success`, `message`, `data`, `errorCode`, `errors`. |
| 2026-05-01 | Command Center | Added full Command Center settings contract used by latest FE. |
| 2026-05-01 | Lore Events | Marked Events as a first-class lore category required by FE. Current backend schema must add event support or a compatible category mapping. |
| 2026-05-01 | Management | Expanded workflow, quota, team, review, and side-effect requirements. |
| 2026-05-01 | Chat | Added required chat parity details for DMs, groups, invites, attachments, replies, unread state, and system-managed channels. |
| 2026-05-01 | Settings | Expanded PL7 extraction job requirement. |
| 2026-05-01 | QA | Added acceptance criteria that separate deployment smoke checks from functional QA. |
| 2026-05-01 | Content lazy load | Added explicit backend list contracts for high-volume Gallery and Lore card content. |
| 2026-05-02 | Realtime and polling | Added explicit Chat WebSocket and Extraction polling progress requirements. |
| 2026-05-02 | Sidebar indicators | Added navigation badge aggregate endpoint and realtime update requirements for Chat, Management, and Notifications. |

## 1. Purpose and Reading Order [Updated 2026-05-01]

This document is the primary backend contract for replacing the current frontend localStorage-backed services with REST APIs while preserving current FE behavior.

Read in this order:

1. Section 2 for integration status and current backend gaps.
2. Section 3 for global API conventions.
3. Sections 4 to 18 for module contracts.
4. Section 19 for seed and migration requirements.
5. Section 20 for QA and acceptance gates.
6. Section 21 for current backend parity gap checklist.

Companion documents:

- `frontend-feature-validation-report-2026-05-01.md`: latest FE feature and demo-readiness report.
- `production-readiness-chat-plan.md`: chat production hardening roadmap.
- `full-platform-readiness-assessment-2026-04-27.md`: earlier platform readiness snapshot.
- `functionality_test.md`: latest FE automated validation context.

## 2. Integration Status Snapshot [Updated 2026-05-01]

### 2.1 Frontend status

The latest FE is demo-ready with caveats. It still stores active data in localStorage and seed JSON. It does not yet call REST endpoints for the reviewed feature flows.

Current FE service files that must be replaced by REST-backed adapters:

| Module | FE source |
|---|---|
| Auth | `src/contexts/AuthContext.tsx` |
| Personnel | `src/services/personnelApi.ts` |
| Command Center | `src/services/commandCenterSettings.ts` |
| Projects | `src/services/projectsApi.ts` |
| Lore | `src/services/loreApi.ts` |
| Events | `src/services/eventsApi.ts` |
| Discussions | `src/services/discussionApi.ts` |
| Gallery | `src/services/galleryApi.ts` |
| News | `src/services/newsApi.ts` |
| Map | `src/services/mapApi.ts` |
| Management | `src/services/managementApi.ts` |
| Notifications | `src/services/notificationsApi.ts` |
| Chat | `src/services/chatApi.ts` |
| Settings extraction | `src/services/extractionService.ts` |

### 2.2 Backend status

Current backend implementation has:

- Express, TypeScript, Prisma, PostgreSQL.
- Auth routes, refresh token storage, JWT claims, security middleware, health and readiness probes.
- Route groups for auth, projects, lore, gallery, map, personnel, settings, news, and files.
- `/api` and `/v1` route mounts.
- Seed import from FE sample data.
- Deploy smoke test status only, no QA status.

Current backend implementation does not yet fully satisfy the latest FE parity contract:

- Management workflow routes are not present in the current router list.
- Notifications routes are not present in the current router list.
- Chat routes are not present in the current router list.
- PL7 extraction job routes are not present in the current router list.
- Current Prisma `CommandCenterSettings` model does not include every FE setting flag.
- Current Prisma `LoreItem` model is too generic for all FE lore shapes unless the API response flattens and maps all required fields.
- Current Prisma `EntityType` does not include `event`, while FE has Events as a first-class lore category.
- Current project schema uses enum names without spaces in DB, while FE requires status strings with spaces in API JSON.
- Current register endpoint does not return tokens, while FE needs immediate post-register authenticated state.
- Current FE accepts a 6 character password in demo, while current BE requires 12 characters. Production should keep 12, but FE must be updated before live integration.

## 3. Global API Contract [Updated 2026-05-01]

### 3.1 Base paths

Backend must support both paths during migration:

```text
/api
/v1
```

Example:

```text
GET /api/projects
GET /v1/projects
```

### 3.2 Health and readiness

Required:

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | public | Service process health. |
| GET | `/ready` | public | Database readiness check. |

Response examples:

```json
{ "success": true, "data": { "status": "ok", "env": "production" } }
```

```json
{ "success": true, "data": { "status": "ready" } }
```

Readiness failure:

```json
{
  "success": false,
  "message": "Database not ready",
  "errorCode": "SERVICE_UNAVAILABLE"
}
```

### 3.3 Response envelope

Current backend uses a response envelope. Keep this as the wire contract:

Success:

```json
{
  "success": true,
  "message": "Optional message",
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "message": "Validation failed",
  "errorCode": "VALIDATION_ERROR",
  "errors": [
    { "path": "title", "message": "Required" }
  ]
}
```

FE REST adapters must unwrap `data` before returning values to existing page code. Existing FE local services return bare arrays or entities, so the adapter layer is responsible for preserving that interface.

### 3.4 Error codes

Required canonical codes:

| HTTP | errorCode | Meaning |
|---:|---|---|
| 400 | `BAD_REQUEST` | Malformed request or unsupported query. |
| 401 | `UNAUTHORIZED` | Missing, expired, or invalid token. |
| 403 | `FORBIDDEN` | Authenticated but not permitted. |
| 404 | `NOT_FOUND` | Resource does not exist or is hidden from viewer. |
| 409 | `CONFLICT` | Unique conflict or state conflict. |
| 422 | `VALIDATION_ERROR` | Field-level validation failure. |
| 429 | `RATE_LIMITED` | Non-auth rate limit. |
| 429 | `AUTH_RATE_LIMITED` | Auth-specific rate limit. |
| 503 | `SERVICE_UNAVAILABLE` | Database or dependent service unavailable. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected server failure. |

### 3.5 Auth header

```http
Authorization: Bearer <access_token>
```

JWT claims required:

```ts
{
  sub: string;
  username: string;
  role: "author" | "personel" | "guest";
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  track: "executive" | "field" | "mechanic" | "logistics";
  iat: number;
  exp: number;
}
```

### 3.6 JSON shape rules

Backend JSON must match FE TypeScript variable names.

Rules:

- Use camelCase in API JSON.
- `id` is always a string.
- Arrays must default to `[]`, never `null`.
- Optional strings may be `""` or omitted, but should not be `null` unless explicitly documented.
- API JSON must preserve FE enum values exactly, even if DB enum names differ.
- Date-only fields must be `YYYY-MM-DD`.
- Datetime fields must be ISO 8601 UTC.

Important FE enum values:

```ts
Project.status = "Planning" | "On Progress" | "On Hold" | "Completed" | "Canceled"
GalleryItem.type = "image" | "video"
DocItem.type = "image" | "video" | "file"
NewsAttachment.type = "image" | "video" | "link"
MapMarker.status = "safe" | "caution" | "danger" | "restricted" | "mission"
Creature.classification =
  "Amorphous" | "Crystalline" | "Metamorphic" | "Catalyst" | "Singularity" | "Zero-State"
Creature.dangerLevel = 1 | 2 | 3 | 4 | 5
RequestStatus = "pending" | "approved" | "rejected"
```

### 3.7 Pagination, lazy-load, and list compatibility [Updated 2026-05-01]

Large list endpoints should support:

```text
?page=1&pageSize=50&q=<search>&sort=-createdAt
?cursor=<opaque-cursor>&limit=24&q=<search>&sort=-createdAt
```

Preferred paginated response:

```json
{
  "success": true,
  "data": {
    "items": [],
    "page": 1,
    "pageSize": 50,
    "total": 0,
    "totalPages": 0,
    "hasNextPage": false,
    "nextCursor": null
  }
}
```

For phase 1 FE parity, backend may return `data` as a bare array for small lists. FE adapter must support both:

- `data: []`
- `data: { items: [] }`

High-volume list rules:

- Gallery, Lore, News, Projects, Personnel, Management requests, Chat conversations, Chat messages, notifications, and Command Center selection options must support bounded list responses.
- FE lazy loading must not depend on fetching the full table first.
- List endpoints should return card-summary or row-summary records by default.
- Detail endpoints should return full records with long text, comments, docs, attachments, field notes, observations, and metadata.
- `pageSize` and `limit` must be capped server-side. Recommended default is 24 for card grids and 50 for table rows.
- `q`, filter, and sort parameters must be applied before pagination.
- `thumbnail` should be returned as a lightweight URL or storage path. Full image/video payloads must not be embedded in list responses.

### 3.8 Validation policy

Production API should enforce field validation even if current Author Dashboard allows blank fields. To reduce integration churn:

- FE must display `VALIDATION_ERROR` field messages.
- Backend must identify all invalid fields in one response where practical.
- Optional media fields must accept empty string during phase 1, but non-empty values must be either a valid URL, an absolute app route where allowed, or a storage path returned from upload endpoints.

## 4. Authorization Model [Updated 2026-05-01]

PL means Personnel Level and is the server-side authority source.

| PL | Role mapping | Summary |
|---:|---|---|
| 0 | guest | Guest or external viewer. |
| 1 | personel | New registered personnel. |
| 2 | personel | Personal submission path. |
| 3 | personel | Team leader path. |
| 4 | personel | Supervisor and review authority for same track. |
| 5 | personel | Division director and transfer reviewer for target track. |
| 6 | personel | Board level, track-aware Author Panel access. |
| 7 | author | Full Authority and superuser. |

Tracks:

```ts
"executive" | "field" | "mechanic" | "logistics"
```

Author Panel access rules that backend must enforce:

| Viewer | Projects | Lore Characters | Lore Places | Lore Technology | Lore Creatures | Lore Other | Gallery | News | Command Center | Map | Personnel |
|---|---|---|---|---|---|---|---|---|---|---|---|
| author or PL7 | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| L6 executive | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | no |
| L6 field | no | no | yes | no | yes | no | own uploads only | no | no | no | no |
| L6 mechanic | yes | no | no | yes | no | no | own uploads only | no | no | no | no |
| L6 logistics | no | no | no | no | no | no | own uploads only | no | no | no | no |
| L0-L5 | no write access | no write access | no write access | no write access | no write access | no write access | no write access except workflow-approved submissions | no | no | no | no |

Discussion moderation:

- Author and PL7 can moderate.
- L6 executive can moderate.
- Comment/reply author can edit or delete their own content.

Server must not rely on hidden frontend buttons. Every write endpoint must enforce these rules.

## 5. Auth Module [Updated 2026-05-01]

### 5.1 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Create user and personnel profile. |
| POST | `/auth/login` | public | Authenticate and return tokens. |
| POST | `/auth/guest` | public | Issue short-lived guest token. |
| GET | `/auth/me` | bearer | Return current user claim snapshot. |
| POST | `/auth/logout` | bearer | Revoke active refresh tokens for user. |
| POST | `/auth/refresh` | public | Rotate refresh token. |
| POST | `/auth/validate-token` | bearer | Validate access token. |

### 5.2 Register request

```json
{
  "email": "agent@example.com",
  "username": "agentuser",
  "password": "SeedPassword123"
}
```

Validation:

- `email`: valid email, unique.
- `username`: 3 to 30 characters, unique, case-insensitive uniqueness preferred.
- `password`: 12 to 128 characters for production.

Current FE demo allows 6 characters. Before FE is switched to REST, either update FE copy and validation to 12 characters or add a documented staging-only compatibility mode. Production must use 12 minimum.

### 5.3 Register response

Requirement: register must return the same authenticated payload as login so FE can navigate directly to `/home`.

```json
{
  "success": true,
  "message": "Registered",
  "data": {
    "token": "access.jwt",
    "refreshToken": "refresh.jwt",
    "user": {
      "id": "uuid",
      "username": "agentuser",
      "email": "agent@example.com",
      "role": "personel",
      "level": 1,
      "track": "executive",
      "note": ""
    }
  }
}
```

### 5.4 Login response

```json
{
  "success": true,
  "data": {
    "token": "access.jwt",
    "refreshToken": "refresh.jwt",
    "user": {
      "id": "uuid",
      "username": "author",
      "email": "author@morneven.com",
      "role": "author",
      "level": 7,
      "track": "executive",
      "note": "Founder"
    }
  }
}
```

### 5.5 Side effects

On register:

- Create user/personnel row with role `personel`, level `1`, track `executive`.
- Create default Command Center settings.
- Add the new user to the institute chat conversation when chat backend exists.
- Create a welcome notification when notifications backend exists.

## 6. Personnel Module [Updated 2026-05-01]

### 6.1 Data shape

```ts
PersonnelUser = {
  id: string;
  username: string;
  email: string;
  role: "author" | "personel" | "guest";
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  track: "executive" | "field" | "mechanic" | "logistics";
  note?: string;
  updatedAt?: string;
}
```

### 6.2 Routes

| Method | Path | Auth | Request | Response data |
|---|---|---|---|---|
| GET | `/personnel` | PL >= 4 | `?track=&level=&q=` | `PersonnelUser[]` |
| GET | `/personnel/:id` | PL >= 4 or self | none | `PersonnelUser` |
| POST | `/personnel` | PL >= 6 | `PersonnelCreateRequest` | `PersonnelUser` |
| PUT | `/personnel/:id` | PL >= 5, same track, or PL >= 6 | partial personnel fields | `PersonnelUser` |
| PATCH | `/personnel/bulk` | PL >= 6 | see below | `PersonnelUser[]` |
| DELETE | `/personnel/:id` | PL >= 7 | none | `{ deleted: true }` |

### 6.3 Bulk update body

FE service expects:

```json
{
  "ids": ["uuid-1", "uuid-2"],
  "patch": {
    "level": 4,
    "track": "field"
  }
}
```

If current backend uses `updates: [{ id, ...patch }]`, add support for the FE body above to avoid adapter branching.

### 6.4 Validation

- `username` and `email` are required on create.
- New create UI must not create L7 unless the caller is PL7 and request is explicitly allowed.
- L7 records cannot be deleted from UI and must also be protected server-side unless a separate break-glass admin path exists.
- Changing `level` must synchronize `role`:
  - level 7 -> `author`
  - level 1 to 6 -> `personel`
  - level 0 -> `guest`
- Changing `track` must trigger chat division membership reconciliation when chat backend exists.
- Every create, update, bulk update, and delete must write audit log.

## 7. Command Center Settings [Updated 2026-05-01]

### 7.1 Data shape

The current FE settings object is:

```ts
CommandCenterSettings = {
  showStats: boolean;
  showProjects: boolean;
  showNews: boolean;
  showCharacters: boolean;
  showPlaces: boolean;
  showTechnology: boolean;
  showGallery: boolean;
  showQuickActions: boolean;
  welcomeMessage: string;
  itemLimits: {
    projects: number;
    news: number;
    characters: number;
    places: number;
    technology: number;
    gallery: number;
  };
  manualSelections: {
    projects: string[];
    news: string[];
    characters: string[];
    places: string[];
    technology: string[];
    gallery: string[];
  };
}
```

### 7.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/settings/command-center` | bearer | Get settings for current user. |
| PUT | `/settings/command-center` | author, PL7, or L6 executive | Update current user's settings. |
| GET | `/settings/command-center/defaults` | bearer | Return server defaults. |

### 7.3 Requirements

- Backend model must include every boolean flag above.
- Missing settings row should return default settings, not `null`.
- `itemLimits` value `0` means no cap.
- `manualSelections[section]` overrides `itemLimits` when non-empty.
- IDs in `manualSelections` should be validated against the relevant resource where possible. Unknown IDs may be dropped or return 422, but behavior must be documented.
- Update must return the full merged settings object.

## 8. Projects Module [Updated 2026-05-01]

### 8.1 Data shape

```ts
Project = {
  id: string;
  title: string;
  status: "Planning" | "On Progress" | "On Hold" | "Completed" | "Canceled";
  thumbnail: string;
  shortDesc: string;
  fullDesc: string;
  patches: { version: string; date: string; notes: string }[];
  docs: DocItem[];
  archived?: boolean;
  contributor?: string;
  meta?: LoreMeta;
}
```

### 8.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/projects` | guest token or bearer | List projects. |
| GET | `/projects/:id` | guest token or bearer | Project detail. |
| POST | `/projects` | author, PL7, L6 executive, L6 mechanic, or management approval | Create project. |
| PUT | `/projects/:id` | author, PL7, L6 executive, L6 mechanic, or contributor where allowed | Update project. |
| POST | `/projects/:id/archive` | author, PL7, or L6 executive | Archive project. |
| DELETE | `/projects/:id` | author or PL7 | Delete project. |

### 8.3 List query

```text
GET /projects?status=On%20Progress&archived=false&q=pantry&page=1&pageSize=50
```

Requirements:

- Default `archived=false`.
- Archived tab needs `archived=true`.
- Status strings in API must use FE values with spaces.
- If DB enum uses `OnProgress`, API serializer must return `On Progress`.

### 8.4 Validation

- `title`, `status`, `shortDesc`, and `fullDesc` are required.
- `thumbnail` may be empty string in phase 1. If non-empty, validate URL or storage path.
- `patches` defaults to `[]`.
- `docs` defaults to `[]`.
- `docs[].type` must be `image`, `video`, or `file`.
- `meta.patchNotes[].date` must be `YYYY-MM-DD` when present.

## 9. Lore and Events Module [Updated 2026-05-01]

### 9.1 Categories required by FE

FE requires these categories:

```text
characters
places
technology
creatures
events
other
personnel
```

`personnel` is a reference page and does not use lore CRUD. All other categories require list and detail routes.

### 9.2 Common shapes

```ts
DocItem = {
  type: "image" | "video" | "file";
  url: string;
  caption: string;
}

LoreFieldNote = {
  id: string;
  title: string;
  body: string;
  date?: string;
}

LoreMeta = {
  creator?: string;
  owner?: string;
  designer?: string;
  collaborators?: string[];
  team?: string | string[];
  projectName?: string;
  startedAt?: string;
  completedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  patchNotes?: { version: string; date: string; notes: string }[];
  license?: string;
  sourceUrl?: string;
}
```

### 9.3 Entity-specific response requirements

The API must return the same top-level fields used by FE, not only a generic `metadata` object.

Character:

```ts
{
  id, name, race, occupation, height, traits, likes, dislikes,
  accentColor, thumbnail, shortDesc, fullDesc, stats,
  docs, fieldNotes, observations, contributions, discussions,
  contributor, meta
}
```

Place:

```ts
{
  id, name, type, thumbnail, shortDesc, fullDesc,
  docs, fieldNotes, observations, discussions,
  contributor, meta
}
```

Technology:

```ts
{
  id, name, category, thumbnail, shortDesc, fullDesc,
  docs, fieldNotes, observations, discussions,
  contributor, meta
}
```

Creature:

```ts
{
  id, name, classification, dangerLevel, habitat, thumbnail,
  accentColor, shortDesc, fullDesc, docs, fieldNotes,
  observations, discussions, contributor, meta
}
```

Other:

```ts
{
  id, title, category, thumbnail, shortDesc, fullDesc,
  docs, fieldNotes, observations, discussions,
  contributor, meta
}
```

Event:

```ts
{
  id, title, category, era, dateLabel, scope, impactLevel,
  thumbnail, shortDesc, fullDesc, consequences, relatedLinks,
  docs, fieldNotes, observations, discussions, contributor, meta
}
```

### 9.4 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/lore/:category` | guest token or bearer | List category. |
| GET | `/lore/:category/:id` | guest token or bearer | Detail. |
| POST | `/lore/:category` | category write access | Create item. |
| PUT | `/lore/:category/:id` | category write access | Update item. |
| DELETE | `/lore/:category/:id` | author, PL7, or L6 executive | Delete item. |

Valid `:category` values:

```text
characters, places, technology, creatures, events, other
```

### 9.4.1 Lazy-load list contract [Updated 2026-05-01]

Lore list endpoints must support category-specific lazy loading. Opening one FE category must not require the backend to return every lore category.

Required query parameters:

```text
GET /lore/:category?page=1&pageSize=24&q=<search>&sort=name
GET /lore/:category?cursor=<opaque-cursor>&limit=24&q=<search>&sort=name
```

Required behavior:

- Apply `:category`, `q`, filters, and `sort` before pagination.
- Return only records for the requested category.
- Return card-summary fields for list requests.
- Do not include heavy detail-only fields in list responses unless explicitly requested.
- Detail-only fields include `fullDesc`, `docs`, `fieldNotes`, `observations`, `discussions`, long metadata history, and large attachment arrays.
- Include `id`, display title/name, `thumbnail`, short description, category/type/classification labels, access indicators, and any small badge fields needed by FE cards.
- Support cache-friendly category fetches so FE can fetch active category once, then reuse it until invalidated.
- Return stable ordering so cursor pagination does not duplicate or skip records.
- Empty categories must return an empty `items` array with valid pagination metadata.

### 9.5 Access rules

| Category | Write access |
|---|---|
| characters | author, PL7, L6 executive |
| places | author, PL7, L6 executive, L6 field |
| technology | author, PL7, L6 executive, L6 mechanic |
| creatures | author, PL7, L6 executive, L6 field |
| other | author, PL7, L6 executive |
| events | author, PL7, L6 executive |

Latest FE caveat: Author Dashboard does not yet expose create/edit/delete for Events. Backend must still support Events now so FE can wire it without another BE revision.

### 9.6 Restricted content

FE supports restricted blocks inside `fullDesc`:

```text
[L3+] restricted text [/L3+]
[L5+] restricted text [/L5+]
[L4+ track=field] restricted text [/L4+]
```

Backend requirements:

- Store the raw `fullDesc` unchanged.
- Optional server-side read filtering may redact segments below viewer PL, but it must be consistent with FE behavior.
- `track=` is currently a hint in FE, not a hard gate. If backend enforces track gating later, document it and align FE first.

### 9.7 Validation

- `shortDesc` and `fullDesc` are required for all lore entities.
- `docs`, `fieldNotes`, `observations`, and `discussions` default to `[]`.
- `Creature.dangerLevel` must be 1 to 5.
- `Creature.classification` must match the FE enum exactly.
- `Event.relatedLinks[]` must have `label` and `url`.
- App-internal links such as `/lore/characters/char-007` are valid where FE supports internal links.

## 10. Discussions and Mentions [Updated 2026-05-01]

### 10.1 Supported parents

Discussions are required for:

- Characters.
- Places.
- Technology.
- Creatures.
- Events.
- Other.
- Gallery items.

### 10.2 Shape

```ts
DiscussionMention = {
  username: string;
  start: number;
  end: number;
}

DiscussionReply = {
  id: string;
  author: string;
  text: string;
  date: string;
  mentions?: DiscussionMention[];
}

DiscussionComment = {
  id: string;
  author: string;
  text: string;
  date: string;
  mentions?: DiscussionMention[];
  replies: DiscussionReply[];
}
```

### 10.3 Routes

For lore:

| Method | Path |
|---|---|
| POST | `/lore/:category/:id/comments` |
| PUT | `/lore/:category/:id/comments/:commentId` |
| DELETE | `/lore/:category/:id/comments/:commentId` |
| POST | `/lore/:category/:id/comments/:commentId/replies` |
| PUT | `/lore/:category/:id/comments/:commentId/replies/:replyId` |
| DELETE | `/lore/:category/:id/comments/:commentId/replies/:replyId` |

For gallery:

| Method | Path |
|---|---|
| POST | `/gallery/:id/comments` |
| PUT | `/gallery/:id/comments/:commentId` |
| DELETE | `/gallery/:id/comments/:commentId` |
| POST | `/gallery/:id/comments/:commentId/replies` |
| PUT | `/gallery/:id/comments/:commentId/replies/:replyId` |
| DELETE | `/gallery/:id/comments/:commentId/replies/:replyId` |

### 10.4 Return contract

Lore discussion mutations should return the full updated parent entity because the current FE service does that.

Gallery comment mutations should return the full updated `GalleryItem`.

### 10.5 Validation and side effects

- `text` is required and trimmed.
- Mention spans must satisfy `start >= 0` and `end > start`.
- Mentioned usernames must exist.
- Mention notifications must be created for each mentioned user.
- Users can edit/delete their own comment or reply.
- Author, PL7, and L6 executive can moderate all comments.

## 11. Gallery Module [Updated 2026-05-01]

### 11.1 Data shape

```ts
GalleryItem = {
  id: string;
  type: "image" | "video";
  title: string;
  thumbnail: string;
  videoUrl?: string;
  caption: string;
  tags: string[];
  date: string;
  comments: GalleryComment[];
  uploadedBy?: string;
}
```

### 11.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/gallery` | guest token or bearer | List gallery items. |
| GET | `/gallery/:id` | guest token or bearer | Detail. |
| POST | `/gallery` | author, PL7, L6, PL4 direct upload, or management approval | Create gallery item. |
| PUT | `/gallery/:id` | uploader, author, or PL7 | Update own or privileged item. |
| DELETE | `/gallery/:id` | uploader, author, or PL7 | Delete own or privileged item. |

### 11.3 Requirements

- `type` must be `image` or `video`.
- `title` and `caption` are required.
- `thumbnail` may be empty string in phase 1. If non-empty, validate URL or storage path.
- `videoUrl` is required when `type=video`, unless the video is represented by `thumbnail` plus attachment in a later design.
- `tags` defaults to `[]`.
- `comments` defaults to `[]`.
- `uploadedBy` must be the username in API JSON, not just user id, because FE displays username and applies ownership by username.

### 11.4 Lazy-load list contract [Updated 2026-05-01]

Gallery list endpoint must support FE lazy loading for card grids.

Required query parameters:

```text
GET /gallery?page=1&pageSize=24&q=<search>&type=image&sort=-date
GET /gallery?cursor=<opaque-cursor>&limit=24&q=<search>&type=video&sort=-date
```

Required behavior:

- Apply `q`, `type`, and `sort` before pagination.
- Return card-summary fields for list requests.
- Card-summary fields are `id`, `type`, `title`, `thumbnail`, `date`, `tags`, and `uploadedBy`.
- Do not include `comments` in list responses by default. Comments belong to detail responses.
- Do not embed raw image or video content in the list response.
- Return lightweight thumbnail URLs or storage paths only.
- Support `image`, `video`, and omitted `type` filter.
- Empty result sets must return an empty `items` array with valid pagination metadata.
- Server must cap `pageSize` or `limit` to prevent FE or client misuse from returning the full Gallery table.

## 12. News Module [Updated 2026-05-01]

### 12.1 Data shape

```ts
NewsItem = {
  id: string;
  text: string;
  date: string;
  body?: string;
  thumbnail?: string;
  attachments?: NewsAttachment[];
  hasDetail?: boolean;
}

NewsAttachment = {
  type: "image" | "video" | "link";
  url: string;
  caption?: string;
}
```

### 12.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/news` | guest token or bearer | List news sorted by newest date first. |
| GET | `/news/:id` | guest token or bearer | Detail page data. |
| POST | `/news` | author, PL7, or L6 executive | Create news. |
| PUT | `/news/:id` | author, PL7, or L6 executive | Update news. |
| DELETE | `/news/:id` | author, PL7, or L6 executive | Delete news. |

### 12.3 Validation

- `text` is required.
- `date` is required and must be `YYYY-MM-DD`.
- If `hasDetail=false`, backend should ignore or clear `body`, `thumbnail`, and `attachments` unless preserving draft data is explicitly added.
- If `hasDetail=true`, `body` may be empty during phase 1 but should be required before production publishing.
- `attachments[].type` must be `image`, `video`, or `link`.
- `attachments[].url` can be an app-internal route or external URL for `link`; it must be URL or storage path for image/video.

### 12.4 Side effects

When important news is created with `hasDetail=true`, backend should create a broadcast notification:

```json
{
  "kind": "system",
  "recipient": "*",
  "title": "News published",
  "link": "/news/<id>"
}
```

## 13. Map Module [Updated 2026-05-01]

### 13.1 Data shape

```ts
MapMarker = {
  id: string;
  name: string;
  status: "safe" | "caution" | "danger" | "restricted" | "mission";
  x: number;
  y: number;
  description: string;
  loreLink?: string;
}
```

### 13.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/map/markers` | guest token or bearer | List map markers. |
| PUT | `/map/markers` | author, PL7, or L6 executive | Bulk replace markers. |
| GET | `/map/image` | guest token or bearer | Get map image URL. |
| PUT | `/map/image` | author, PL7, or L6 executive | Update map image URL. |

### 13.3 Validation

- `x` and `y` must be between 0 and 1 inclusive.
- `status` must match FE enum.
- `name` is required.
- `description` defaults to `""`.
- `loreLink` may be empty string or an internal route.
- Bulk replace must be transactional.

## 14. Management Workflows [Updated 2026-05-01]

### 14.1 Required request shape

```ts
MgmtRequest = {
  id: string;
  kind:
    | "transfer"
    | "clearance"
    | "submission_personal"
    | "submission_team"
    | "team_change"
    | "executive_promotion";
  requester: string;
  requesterTrack: PersonnelTrack;
  requesterLevel: PersonnelLevel;
  payload: Record<string, unknown>;
  reason: string;
  status: "pending" | "approved" | "rejected";
  reviewer?: string;
  reviewNote?: string;
  createdAt: string;
  decidedAt?: string;
}
```

### 14.2 Team shape

```ts
Team = {
  id: string;
  name: string;
  leader: string;
  members: string[];
  track: PersonnelTrack;
  createdAt: string;
  cycleYear: number;
  completed: number;
}
```

### 14.3 Quota shape

```ts
QuotaRecord = {
  username: string;
  monthly: Record<string, number>;
  yearly: Record<string, number>;
  supervised: Record<string, number>;
}
```

Quota response must also include computed statuses:

```json
{
  "username": "j.fenris",
  "monthly": { "2026-05": 1 },
  "yearly": { "2026": 0 },
  "supervised": { "2026": 1 },
  "pl2": { "met": true, "count": 1 },
  "pl3": { "met": false, "count": 0 },
  "pl4": { "met": false, "count": 1, "target": 2 }
}
```

### 14.4 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/mgmt/requests` | bearer | List requests visible to current user. |
| POST | `/mgmt/requests` | PL >= 1 | Create request for current user only. |
| POST | `/mgmt/requests/:id/decide` | reviewer rule | Approve or reject. |
| GET | `/mgmt/teams` | PL >= 3 or reviewer | List teams. |
| POST | `/mgmt/teams` | PL >= 3 | Create team for current user as leader. |
| GET | `/mgmt/quotas/:username` | self or PL >= 4 | Return quota record and computed status. |
| GET | `/mgmt/requests/pending-count` | bearer | Count pending requests current user can decide. |

### 14.5 Create request body

```json
{
  "kind": "clearance",
  "payload": { "targetLevel": 3 },
  "reason": "Completed required work."
}
```

Server must derive these fields from JWT, not trust client values:

- `requester`
- `requesterTrack`
- `requesterLevel`
- `status`
- `createdAt`

### 14.6 Review authorization

Server-side rules:

```text
deny if request.status is not pending
deny if reviewer.username equals request.requester
allow if reviewer.level >= 7

executive_promotion:
  allow if reviewer.level >= 6

transfer:
  allow if reviewer.level >= 5 and reviewer.track equals payload.targetTrack

clearance, submission_personal, submission_team, team_change:
  allow if reviewer.level >= 4 and reviewer.track equals request.requesterTrack

deny otherwise
```

### 14.7 Workflow validation

Transfer:

- PL7 cannot transfer.
- `targetTrack` is required and must differ from current track.
- Reason required.

Clearance:

- Standard application supports L1 to L4 path.
- `targetLevel` must equal `requesterLevel + 1`.
- Reason required.

Personal submission:

- `payload.item.title` required.
- `payload.item.caption` required.
- Approval creates Gallery item with `uploadedBy=requester`.
- Approval increments monthly quota once.

Team submission:

- Requester must be team leader of `payload.teamId`.
- Project title and caption/description required.
- Approval creates Project with `contributor=requester`.
- Approval increments yearly quota once.
- Approval increments reviewer supervised quota once.

Team creation:

- Requester must be PL >= 3.
- Team name required.
- Members must be same track and eligible.
- FE copy says 2 to 5 members including leader. That means backend should allow 1 to 4 selected members plus leader.

Team change:

- Requester must be team leader.
- `teamId`, `member`, and `action` required.
- `action` must be `add` or `remove`.

Executive promotion:

- Requester must be PL4.
- `plan` and reason required.
- Approval sets level to 5.

### 14.8 Transaction side effects

Approving a request must update status and all side effects in one transaction:

| Kind | Side effect |
|---|---|
| transfer | Update personnel track, sync division chat, notify requester. |
| clearance | Update personnel level, sync role if needed, notify requester. |
| submission_personal | Create gallery item, bump monthly quota, notify requester. |
| submission_team | Create project, bump yearly quota, bump reviewer supervised quota, notify requester. |
| team_change | Update team members, sync team chat. |
| executive_promotion | Update personnel level to 5, notify requester. |

Rejection should only update request status, reviewer, note, and decidedAt.

## 15. Notifications Module [Updated 2026-05-01]

### 15.1 Data shape

```ts
AppNotification = {
  id: string;
  kind: "info" | "warning" | "system" | "mention" | "request";
  title: string;
  body?: string;
  recipient: string;
  sender?: string;
  createdAt: string;
  read: boolean;
  link?: string;
}
```

### 15.2 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/notifications` | bearer | List notifications for current user plus broadcasts. |
| GET | `/notifications/unread-count` | bearer | Return unread count. |
| POST | `/notifications` | author, PL7, or system | Create notification or warning. |
| POST | `/notifications/:id/read` | recipient | Mark one as read. |
| POST | `/notifications/read-all` | bearer | Mark all current user notifications as read. |
| DELETE | `/notifications` | bearer | Clear all current user notifications. |

### 15.3 Requirements

- `recipient="*"` means broadcast.
- `listNotifications` must sort newest first.
- Mention, management, chat invite, message, and system events must create notifications.
- WebSocket event `notification.created` should be emitted after insert.

### 15.4 Navigation badges and sidebar indicators [Updated 2026-05-02]

Latest FE sidebar requires domain-derived badge counts for high-priority actionable state. These counts must not be derived by loading full chat, management, or notification collections on the client.

Required aggregate endpoint:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/me/navigation-badges` | bearer | Return global sidebar badge counts for the current user. |

Because the backend mounts routes under both `/api` and `/v1`, the production FE should be able to call:

```text
GET /v1/me/navigation-badges
```

Response:

```json
{
  "success": true,
  "data": {
    "chatUnreadCount": 4,
    "managementPendingCount": 2,
    "notificationUnreadCount": 7
  }
}
```

Count semantics:

- `chatUnreadCount` is the sum of unread non-system messages authored by other users across conversations visible to the current user.
- Chat unread state is based on persisted per-user, per-conversation read cursors, not notification read state.
- `managementPendingCount` is the number of pending management requests the current user is authorized to decide.
- Management pending count must exclude requests submitted by the current user.
- Management pending count must apply the same PL/track reviewer rules as request approval.
- `notificationUnreadCount` is the user's unread notification inbox count, including visible broadcasts that the user has not marked read.
- These values are operational sidebar state. They must remain correct even if notification rows are marked read, cleared, or archived.

Realtime update requirement:

- Production should emit WebSocket event `navigation_badges.updated` whenever one or more badge counts change for a user.
- Payload should match the aggregate endpoint `data` shape.
- Emit after chat message create/delete, chat read cursor update, management request create/decide/delete, notification create/read/read-all/clear, personnel change, and team membership change where counts may be affected.
- If WebSocket is unavailable, FE may poll `GET /v1/me/navigation-badges` every 30 to 60 seconds.

Recommended event payload:

```json
{
  "chatUnreadCount": 5,
  "managementPendingCount": 1,
  "notificationUnreadCount": 8
}
```

Split endpoints are allowed only as secondary helpers:

```text
GET /v1/chat/unread-count
GET /v1/management/requests/pending-count
GET /v1/notifications/unread-count
```

The aggregate endpoint remains required because the sidebar is global and appears across most authenticated screens.

## 16. Chat Module [Updated 2026-05-01]

### 16.1 Required features

Latest FE demo expects:

- Direct messages.
- Manual groups.
- System-managed team channels.
- System-managed division channels.
- System-managed institute channel.
- Invites with accept and reject.
- Owner, admin, and member roles.
- Promote, demote, kick, leave, rename for manual groups.
- Attachments with a 5 MB FE demo cap.
- Reply preview.
- Delete own message, or delete as group admin/owner.
- Unread counts and oldest unread scroll behavior.
- PL7 auto-joins all division groups.
- All active personnel join institute group.

### 16.2 Core shapes

```ts
ConversationKind = "dm" | "group" | "team" | "division" | "institute"
MemberRole = "owner" | "admin" | "member"
MemberStatus = "active" | "invited" | "removed"

Conversation = {
  id: string;
  kind: ConversationKind;
  name: string;
  members: ConversationMember[];
  source?: { teamId?: string; track?: PersonnelTrack; institute?: boolean };
  systemManaged?: boolean;
  createdBy: string;
  createdAt: string;
}

ChatMessage = {
  id: string;
  conversationId: string;
  author: string;
  text: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  system?: boolean;
  replyTo?: ReplyPreview;
}
```

### 16.3 Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/chat/conversations` | List active conversations for current user. |
| GET | `/chat/invites` | List pending invites for current user. |
| GET | `/chat/conversations/:id/messages` | List messages. |
| POST | `/chat/messages` | Send message. |
| DELETE | `/chat/messages/:id` | Delete own or moderated message. |
| POST | `/chat/dm` | Create or get DM. |
| POST | `/chat/groups` | Create manual group. |
| POST | `/chat/conversations/:id/invites` | Invite members. |
| POST | `/chat/conversations/:id/invites/accept` | Accept current user's invite. |
| POST | `/chat/conversations/:id/invites/reject` | Reject current user's invite. |
| POST | `/chat/conversations/:id/kick` | Remove member. |
| POST | `/chat/conversations/:id/leave` | Leave manual group. |
| PUT | `/chat/conversations/:id/member-role` | Promote, demote, or transfer owner. |
| PUT | `/chat/conversations/:id/name` | Rename manual group. |
| POST | `/chat/read` | Save last read timestamp. |
| GET | `/chat/unread-counts` | Return unread counts by conversation. |

### 16.3.1 Realtime transport [Updated 2026-05-02]

Production chat should support WebSocket realtime events. REST remains required for initial load, pagination, uploads, conversation management, invites, and recovery after reconnect.

Recommended WebSocket namespace:

```text
/ws/chat
```

Connection requirements:

- Authenticate the socket with the same bearer token or a short-lived socket token derived from the authenticated session.
- Join only conversations where the current user is an active or invited member.
- Revalidate membership on reconnect.
- Remove socket subscriptions when a user leaves, is kicked, or loses access through personnel/team changes.
- Persist every message before emitting events.
- Send missed messages through REST pagination after reconnect instead of relying on socket replay only.

Required realtime events:

| Event | Direction | Purpose |
|---|---|---|
| `chat.message.created` | server to client | New persisted message. |
| `chat.message.deleted` | server to client | Message removed by author, owner, or admin. |
| `chat.message.updated` | server to client | Message edit if edit support is added. |
| `chat.read.updated` | bidirectional | Read cursor changed. |
| `chat.typing.started` | client to server to clients | Typing indicator. |
| `chat.typing.stopped` | client to server to clients | Typing indicator end. |
| `chat.conversation.created` | server to client | New DM, group, team, division, or institute conversation visible to user. |
| `chat.conversation.updated` | server to client | Rename, role change, membership change, or system sync. |
| `chat.invite.created` | server to client | User received an invite. |
| `chat.invite.resolved` | server to client | Invite accepted, rejected, or revoked. |
| `chat.unread.updated` | server to client | Conversation unread count changed. |

Fallback requirement:

- If WebSocket is unavailable, FE may poll `GET /chat/conversations`, `GET /chat/conversations/:id/messages`, and `GET /chat/unread-counts` every 5 to 10 seconds.
- Polling fallback is acceptable for demo or degraded mode, not the preferred production path.

### 16.4 Message send body

```json
{
  "conversationId": "uuid",
  "text": "Message body",
  "attachments": [
    {
      "id": "uuid",
      "name": "brief.png",
      "mimeType": "image/png",
      "size": 12345,
      "url": "/storage/chat/brief.png"
    }
  ],
  "replyTo": {
    "messageId": "uuid",
    "author": "j.huang",
    "text": "Previous message",
    "hasAttachments": false
  }
}
```

### 16.5 Rules

- User must be an active member to read or send.
- Text or at least one attachment is required.
- Manual group creation requires name and at least one invitee.
- DM target cannot be current user.
- System-managed conversations cannot be renamed, left, kicked, or manually invited.
- Owner can promote/demote.
- Owner and admin can kick, except they cannot kick owner.
- Admin cannot kick another admin.
- If owner leaves a manual group, promote earliest active admin, else earliest active member.
- Sending message creates notifications for active members except sender.

### 16.6 Reconciliation jobs

Backend must provide server-side equivalents for:

- `reconcileAutoMemberships(personnel)`
- `syncDivisionMembership(username, track)`
- `syncTeamGroup(teamId, teamName, members)`

Triggers:

- Personnel created.
- Personnel level changed.
- Personnel track changed.
- Team created.
- Team members changed.

## 17. Files and Uploads [Updated 2026-05-01]

### 17.1 Current backend route

Current backend has:

```text
POST /files/upload
```

with multipart field:

```text
file
```

and optional:

```text
?folder=gallery
```

### 17.2 Required response

```json
{
  "success": true,
  "data": {
    "objectPath": "gallery/uuid-image.png",
    "provider": "local",
    "location": "storage",
    "contentType": "image/png",
    "size": 12345,
    "url": "/storage/gallery/uuid-image.png"
  }
}
```

### 17.3 Upload rules

- Auth required.
- Allowed scopes: `gallery`, `lore`, `projects`, `news`, `map`, `chat`, `exports`, `uploads`.
- Max upload size must be controlled by `MAX_UPLOAD_MB`.
- Public files: gallery, lore, projects, news, map.
- Private files: chat and extraction exports unless explicitly published.
- If local storage is used in Railway, persistent volume is required for durable media.
- If GCS is used, return public object URL or signed URL according to scope.

### 17.4 Future presigned flow

For larger media, add:

| Method | Path | Purpose |
|---|---|---|
| POST | `/files/sign` | Return signed upload URL. |
| POST | `/files/confirm` | Confirm upload and return final URL. |

## 18. Settings and PL7 Extraction [Updated 2026-05-01]

### 18.1 FE feature summary

Settings page includes:

- Theme preference.
- Account and role summary.
- Obligation counters.
- PL7-only data extraction.

Theme can remain frontend-local until profile preferences are implemented.

### 18.2 Extraction job shape

```ts
ExtractionJob = {
  id: string;
  mode: "db" | "images" | "all";
  autoDownload: boolean;
  status: "processing" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
  downloadName?: string;
  artifactUrl?: string;
  error?: string;
}
```

### 18.3 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/settings/extractions` | PL7 | List active extraction jobs. |
| POST | `/settings/extractions` | PL7 | Start extraction job. |
| GET | `/settings/extractions/:id` | PL7 | Get job status. |
| GET | `/settings/extractions/:id/download` | PL7 | Download completed ZIP or signed URL. |
| DELETE | `/settings/extractions` | PL7 | Clear selected or all jobs. |

Start body:

```json
{
  "mode": "all",
  "confirmText": "CONFIRM",
  "password": "current account password"
}
```

### 18.3.1 Progress polling [Updated 2026-05-02]

Extraction does not require WebSocket or SSE for phase 1. The required implementation is an async background job with REST polling.

Required flow:

1. FE calls `POST /settings/extractions`.
2. Backend creates a job and returns `id`, `status="processing"`, `createdAt`, and `expiresAt`.
3. FE polls `GET /settings/extractions/:id` every 2 to 5 seconds while the job is `processing`.
4. Backend returns updated job status and progress fields.
5. When status becomes `completed`, FE enables `GET /settings/extractions/:id/download`.
6. If status becomes `failed`, FE displays `error`.

Recommended progress fields:

```ts
ExtractionJobProgress = {
  percent?: number;
  stage?: "queued" | "collecting" | "compressing" | "uploading" | "completed" | "failed";
  message?: string;
}
```

Polling response requirement:

```json
{
  "success": true,
  "data": {
    "id": "job-id",
    "status": "processing",
    "progress": {
      "percent": 40,
      "stage": "compressing",
      "message": "Compressing selected media"
    }
  }
}
```

Optional future enhancement:

- SSE endpoint `GET /settings/extractions/:id/events` may be added later for live progress, but REST polling remains the required baseline.
- ZIP download may use normal HTTP streaming. This is not the same as realtime event streaming.

### 18.4 Validation

- Caller must be PL7.
- `confirmText` must equal `CONFIRM`.
- Password must verify against current account.
- Export jobs expire after 30 days.
- Job artifacts must not be public by default.
- Every extraction start, download, and delete must write audit log.

### 18.5 ZIP content

Mode `db`:

```text
db/characters.json
db/creatures.json
db/places.json
db/projects.json
db/technology.json
db/events.json
db/others.json
db/gallery.json
db/news.json
db/personnel.json
db/map.json
```

Mode `images`:

```text
images/map/images.json
images/character/images.json
images/creature/images.json
images/technology/images.json
images/environment/images.json
images/other/images.json
```

Mode `all` includes both sets.

## 19. Seed and Migration [Updated 2026-05-01]

### 19.1 Required seed sources

Backend seed must import the latest FE seed files:

| FE seed | Backend target |
|---|---|
| `characters.json` | lore characters |
| `creatures.json` | lore creatures |
| `events.json` | lore events |
| `gallery.json` | gallery items |
| `map.json` | map image and markers |
| `news.json` | news |
| `other.json` | lore other |
| `personnel.json` | users and personnel |
| `places.json` | lore places |
| `projects.json` | projects and patches |
| `technology.json` | lore technology |

### 19.2 Migration requirements

- Preserve FE IDs as stable external IDs where possible, or provide `legacyId` mapping.
- Preserve username values because FE ownership and mentions use username.
- Preserve `uploadedBy` as username in API JSON.
- Preserve `contributor` as username.
- Preserve all docs, field notes, observations, metadata, comments, replies, and mentions.
- Preserve date-only fields as `YYYY-MM-DD`.
- Normalize project DB enum internally if needed, but API JSON must return FE status strings.

### 19.3 Seed account rule

Seed-generated users may use a shared staging password such as `SeedPassword123`, but production must force password rotation or disable seeded passwords.

## 20. QA and Acceptance Criteria [Updated 2026-05-01]

Deployment success is not QA success. The backend cannot be marked FE-ready until these pass.

### 20.1 Minimum backend checks

Required before FE integration:

- `npm run build` passes.
- Prisma generate passes.
- Migration deploy passes against staging database.
- Seed import passes against staging database.
- `/health` returns 200.
- `/ready` returns 200.
- Auth register, login, refresh, logout pass.
- Every route group returns envelope response shape.

### 20.2 FE integration acceptance

Required before replacing localStorage services:

- FE can login and register against backend.
- FE can browse Command Center, Projects, Gallery, Lore, Events, Map, News, Personnel, Management, and Chat without runtime shape errors.
- Every FE service function has a matching endpoint.
- All list endpoints return either `data: []` or `data.items: []` and FE adapter unwraps correctly.
- High-volume Gallery and Lore list endpoints support pagination or cursor loading before FE removes localStorage data sources.
- Gallery and Lore list endpoints return summary records for cards, while detail endpoints return heavy fields.
- Every mutation returns the same entity shape expected by current FE state update logic.
- 422 validation errors are shown in UI and do not crash pages.
- Auth and PL/track restrictions are enforced server-side.
- Uploads return durable URLs.
- Cross-browser state is shared through backend, not localStorage.
- Sidebar indicators load from `GET /v1/me/navigation-badges` without fetching full Chat, Management, or Notifications collections.

### 20.3 Module-specific QA

Projects:

- Filter by status and archived state.
- Create, update, archive, delete with correct authorization.
- Patch notes and docs persist.

Lore:

- All six categories load, including Events.
- Restricted blocks render correctly per PL.
- Metadata, field notes, observations, docs, and discussions persist.

Gallery:

- Image and video items persist.
- Uploaded ownership gates edit and delete.
- Comments and replies persist.

Management:

- Request creation derives requester from JWT.
- Reviewer authorization cannot be bypassed.
- Approval side effects are transactional.
- Quotas increment exactly once.

Chat:

- DM reuse works.
- Group invite, accept, reject work.
- System-managed groups reconcile from personnel and teams.
- Unread counts and last-read timestamps work.
- Attachments upload and download work.

Notifications:

- Mention, chat, management, and broadcast notifications are delivered.
- Read, read-all, clear-all work per user.
- Navigation badge counts reflect Chat unread, reviewable Management requests, and notification unread state.
- `navigation_badges.updated` is emitted when badge counts change, with polling fallback supported.

Extraction:

- PL7 gate works.
- Password and `CONFIRM` are required.
- ZIP contents match mode.
- Expiration and deletion work.

## 21. Current Backend Parity Gap Checklist [Updated 2026-05-01]

Use this checklist to close the gap between current backend implementation and latest FE expectations.

| Priority | Gap | Required action |
|---|---|---|
| P0 | Register does not return token payload | Return `token`, `refreshToken`, and `user` from `/auth/register`. |
| P0 | FE password minimum differs from BE | Update FE to 12 characters before REST switch, or document staging-only compatibility. |
| P0 | Events not represented in Prisma `EntityType` | Add `event` support or dedicated `Event` model and route mapping. |
| P0 | Management routes missing | Implement `/mgmt/*` routes, tables, transactions, quotas, and reviewer rules. |
| P0 | Notifications routes missing | Implement `/notifications/*` and event creation hooks. |
| P0 | Chat routes missing | Implement `/chat/*`, membership reconciliation, messages, unread state, and attachments. |
| P0 | Navigation badge aggregate missing | Implement `/me/navigation-badges`, `navigation_badges.updated`, and polling-compatible count semantics. |
| P0 | FE Command Center settings fields missing in schema | Add all FE flags and return merged defaults. |
| P1 | Project API status values differ from FE | Serialize `OnProgress` as `On Progress` and `OnHold` as `On Hold`, or change DB mapping safely. |
| P1 | Project model lacks docs, archived, contributor, meta | Add fields or compatible relation serialization. |
| P1 | Lore model too generic for FE category shapes | Add typed models or API serializers that return exact FE fields. |
| P1 | Gallery ownership returns user id, FE needs username | Return `uploadedBy` as username in API JSON. |
| P1 | Gallery type allows `link` in DB enum | Ensure Gallery API only accepts `image` or `video`; reserve `link` for NewsAttachment. |
| P1 | Map write authorization stricter than FE contract | Align with author, PL7, and L6 executive. |
| P1 | PL7 extraction missing | Implement extraction job routes and artifact storage. |
| P2 | Audit log missing | Add audit table and write entries for sensitive operations. |
| P2 | Search optional | Add `/search` after core parity is stable. |

## 22. Out of Scope [Updated 2026-05-01]

Not required for this contract:

- Payment or billing.
- SSO or OAuth.
- End-to-end encrypted chat.
- Native mobile push notifications.
- Multi-region active-active deployment.
- Public marketing CMS.

## 23. Final Backend Readiness Definition [Updated 2026-05-01]

Backend can be called "ready for FE integration" only when:

1. All P0 items in Section 21 are complete.
2. All FE service files have matching REST-backed adapters.
3. Staging deploy passes health, readiness, seed, and module smoke tests.
4. Functional QA has been run against FE connected to BE.
5. Any remaining P1 or P2 gaps are documented as accepted release caveats.

Deploy-only status is useful but insufficient. The next milestone should be staging QA with the frontend connected to the backend API.
