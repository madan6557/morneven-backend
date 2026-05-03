# Morneven Backend Railway QA Endpoint Test Guide

Last updated: 2026-05-02

This guide is written for QA endpoint testing against the deployed Railway backend. It expands the original smoke-test guide with request payloads, response contracts, validation rules, query parameters, negative test ideas, seed IDs, and cleanup guidance.

## 1. Environment And Safety

| Item | Value |
| --- | --- |
| Production URL | `https://morneven-backend-production.up.railway.app` |
| Development URL | `https://backend.dev.morneven.com` |
| Default API prefix | `/api` |
| Compatibility prefix | `/v1` |
| Deployment type | Railway deployments for demo and backend integration testing |
| Production QA scope | Read-only smoke, readiness, auth, and non-destructive RBAC verification only |
| Development QA scope | Full functional QA, mutation testing, destructive testing, cleanup verification, and workflow side-effect testing |
| Backend version known from repository | `package.json` version `0.1.0` |
| Build identifier endpoint | Not available yet |

Important safety rules:

- Use the Development URL for full QA, mutation testing, destructive testing, cleanup verification, extraction testing, and workflow side-effect testing.
- Use the Production URL only for read-only smoke checks unless the project owner gives separate written approval.
- Run read-only smoke tests first on the target environment before any mutation.
- For mutating tests on Development URL, create QA-owned records with a prefix such as `QA-20260502-<initials>-<short-purpose>`.
- Destructive testing is allowed on the Development URL, including update, delete, request approval or rejection, file upload, extraction job cleanup, chat message deletion, and cleanup validation.
- Do not update or delete production/demo records on the Production URL.
- Avoid running extraction jobs repeatedly even on Development URL because they may create downloadable archives and consume storage.
- Record test date, base URL, API prefix, account used, and response status for every defect.

Environment selection rule:

| Test Type | Required Target |
| --- | --- |
| Read-only smoke test | Production URL or Development URL |
| Auth login and token validation | Production URL or Development URL |
| RBAC negative checks without mutation | Production URL or Development URL |
| Create, update, delete, upload, extraction, and cleanup tests | Development URL only |
| Full functional QA | Development URL only |
| Destructive testing | Development URL only |

If QA is testing against the Production URL, stop before any create, update, delete, upload, extraction, approval, rejection, or cleanup action.

## 2. Health And Readiness

These endpoints do not require authentication.

| Method | Endpoint | Expected Result |
| --- | --- | --- |
| `GET` | `/health` | `200`, service health payload |
| `GET` | `/ready` | `200` when app and dependencies are ready |
| `GET` | `/api/health` | `200`, same API-prefixed health behavior |
| `GET` | `/api/ready` | `200`, same API-prefixed readiness behavior |
| `GET` | `/v1/health` | `200`, compatibility prefix |
| `GET` | `/v1/ready` | `200`, compatibility prefix |

Expected health response shape:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "env": "production-or-development"
  }
}
```

The exact `data` fields may vary by deployment. QA should capture the actual response in the test report.

## 3. Common Request Rules

Default headers:

```http
Content-Type: application/json
Authorization: Bearer <token>
```

Upload headers:

```http
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Authentication rules:

- Public endpoints: health, readiness, login, register, guest login.
- Protected endpoints require `Authorization: Bearer <token>`.
- Missing token should return `401`.
- Valid token with insufficient role or level should return `403`.
- Invalid JSON body or invalid validation fields should return `400` or `422`, depending on middleware behavior.

Common successful response envelope:

```json
{
  "success": true,
  "message": "Optional message",
  "data": {}
}
```

Common error response envelope:

```json
{
  "success": false,
  "message": "Human readable error",
  "errorCode": "ERROR_CODE",
  "errors": []
}
```

Common paginated response shape:

```json
{
  "success": true,
  "data": {
    "items": [],
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5,
    "hasNextPage": true,
    "nextCursor": "optional-next-id",
    "pageInfo": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5,
      "hasNextPage": true,
      "nextCursor": "optional-next-id"
    }
  }
}
```

## 4. Rate Limit, CORS, And Upload Limits

Known defaults from backend configuration:

| Area | Default |
| --- | --- |
| Global rate limit | `200` requests per `15` minutes per client |
| Auth rate limit | `10` auth requests per `15` minutes per client |
| CORS origins | Controlled by `CORS_ORIGIN` environment variable |
| CORS credentials | Enabled |
| CORS methods | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` |
| CORS headers | `Content-Type`, `Authorization`, `X-Request-Id` |
| Upload max size | Controlled by `MAX_UPLOAD_MB`, default `20 MB` |

QA notes:

- If many login failures suddenly return `429`, wait for the auth rate-limit window.
- Browser QA should verify CORS from the approved frontend origin, not from arbitrary origins.
- API client QA can ignore browser CORS unless testing frontend integration.

## 5. Seed Accounts For QA

Use these accounts for permission and level testing. They are sourced from `fe-seed/personnel.json` and created by `prisma/seed.ts`.

All seeded accounts use this password:

```text
SeedPassword123
```

| ID | Username | Email | Role | Level | Track | QA Purpose |
| --- | --- | --- | --- | ---: | --- | --- |
| `psn-001` | `author` | `author@morneven.com` | `author` | 7 | `executive` | PL7 full authority and extraction testing |
| `psn-002` | `admin` | `admin@morneven.com` | `author` | 7 | `executive` | Alternate PL7 full authority |
| `psn-003` | `v.kessler` | `v.kessler@morneven.com` | `personel` | 6 | `executive` | PL6 executive author access and moderation |
| `psn-004` | `m.varga` | `m.varga@morneven.com` | `personel` | 6 | `field` | PL6 field-limited author access |
| `psn-005` | `s.okafor` | `s.okafor@morneven.com` | `personel` | 6 | `mechanic` | PL6 mechanic-limited author access |
| `psn-006` | `h.kato` | `h.kato@morneven.com` | `personel` | 5 | `logistics` | PL5 logistics reviewer or restricted access checks |
| `psn-007` | `t.bremmer` | `t.bremmer@morneven.com` | `personel` | 4 | `field` | PL4 field workflow checks |
| `psn-008` | `r.alves` | `r.alves@morneven.com` | `personel` | 3 | `executive` | PL3 team lead checks |
| `psn-009` | `guest_visitor` | `guest@morneven.com` | `guest` | 0 | `executive` | Guest and low-privilege checks |
| `psn-010` | `j.huang` | `j.huang@morneven.com` | `personel` | 5 | `mechanic` | PL5 mechanic reviewer checks |
| `psn-011` | `n.osei` | `n.osei@morneven.com` | `personel` | 4 | `logistics` | PL4 logistics workflow checks |
| `psn-012` | `p.salim` | `p.salim@morneven.com` | `personel` | 3 | `field` | PL3 field team checks |
| `psn-013` | `e.ravel` | `e.ravel@morneven.com` | `personel` | 2 | `logistics` | PL2 logistics upload or quota checks |
| `psn-014` | `a.koval` | `a.koval@morneven.com` | `personel` | 2 | `mechanic` | Lower-level mechanic checks |
| `psn-015` | `i.stratos` | `i.stratos@morneven.com` | `personel` | 1 | `field` | PL1 field trainee checks |
| `psn-016` | `y.tanaka` | `y.tanaka@morneven.com` | `personel` | 1 | `executive` | PL1 executive intern checks |

Login request:

```http
POST /api/auth/login
```

```json
{
  "email": "author@morneven.com",
  "password": "SeedPassword123"
}
```

Expected login response:

```json
{
  "success": true,
  "data": {
    "token": "jwt-token",
    "refreshToken": "refresh-token",
    "user": {
      "id": "user-id",
      "email": "author@morneven.com",
      "username": "author",
      "role": "author",
      "level": 7,
      "track": "executive"
    }
  }
}
```

Negative login payload:

```json
{
  "email": "author@morneven.com",
  "password": "wrong-password"
}
```

Expected negative behavior:

- Status `401`.
- Response uses error envelope.
- No token is returned.

## 6. Concrete Seed IDs And Test Data Discovery

Known seeded IDs from FE seed and backend seed files:

| Entity | IDs |
| --- | --- |
| Projects | `proj-001`, `proj-002`, `proj-003` |
| Gallery | `gal-001`, `gal-002`, `gal-003` |
| Characters | `char-001`, `char-002`, `char-003` |
| Places | `place-001`, `place-002`, `place-003` |
| Technology | `tech-001`, `tech-002`, `tech-003` |
| Creatures | `crea-001`, `crea-002`, `crea-003` |
| Events | `evt-001`, `evt-002`, `evt-003` |
| Other lore | `other-001`, `other-002`, `other-004` |
| Users | `psn-001` through `psn-016` from Section 5 |
| Map image | `main` |
| Management requests | `req-seed-1`, `req-seed-2` |
| Teams | `team-seed-ops`, `team-seed-eng` |
| Chat institute conversation | `conv-institute` |
| Chat division conversations | `conv-div-executive`, `conv-div-field`, `conv-div-mechanic`, `conv-div-logistics` |
| Chat team conversations | `conv-team-team-seed-ops`, `conv-team-team-seed-eng` |

Dynamic IDs that QA should discover during test:

| Needed ID | How To Get It |
| --- | --- |
| `conversationId` | `GET /api/chat/conversations` |
| `messageId` | Create message with `POST /api/chat/messages`, then read response |
| `commentId` | Create comment under gallery item, then read response |
| `replyId` | Create reply under comment, then read response |
| `username` | Use seed usernames from login response or `GET /api/personnel` |
| `requestId` | `GET /api/management/requests` or response from create request |
| `extractionJobId` | Response from `POST /api/settings/extractions` |

Do not assume comments, replies, or extraction jobs exist before testing. Create QA-owned test data first.

## 7. Pagination, Filtering, Sorting, And Query Params

Common list query parameters:

| Param | Type | Default | Rule |
| --- | --- | --- | --- |
| `page` | integer | `1` | Minimum `1` |
| `pageSize` | integer | endpoint default | Maximum usually `100` |
| `limit` | integer | optional | Cursor mode alias for `pageSize` |
| `cursor` | string | optional | Uses item ID as cursor when supported |
| `ids` | comma-separated string | optional | Returns only matching IDs |
| `q` | string | optional | Search keyword |
| `search` | string | optional | Alias for `q` |
| `sort` | string | endpoint-specific | See each endpoint section |

Expected pagination behavior:

- `pageSize=0` or negative values should fail or normalize to default.
- `pageSize` above max should cap at the endpoint max.
- Empty result should still return success with `items: []`.
- Invalid cursor should not crash the server.

## 8. Cleanup Rules For QA

Use a single run ID in created data, for example `QA-20260502-AUTHOR`.

Cleanup guidance:

| Entity | Cleanup Method |
| --- | --- |
| Project | `DELETE /api/projects/:id` with authorized account |
| News | `DELETE /api/news/:id` with authorized account |
| Lore item | `DELETE /api/lore/:category/:id` with authorized account |
| Gallery item | `DELETE /api/gallery/:id` with owner or PL7 |
| Gallery comment | `DELETE /api/gallery/:id/comments/:commentId` |
| Gallery reply | `DELETE /api/gallery/:id/comments/:commentId/replies/:replyId` |
| Chat message | `DELETE /api/chat/messages/:id` if user is allowed |
| Chat manual group | No hard-delete endpoint. Use QA prefix and leave it after test. |
| Management request | No hard-delete endpoint. Decide it if workflow requires, otherwise leave QA prefix. |
| Notification | `DELETE /api/notifications/:id` |
| Extraction job | `DELETE /api/settings/extractions` with job IDs |
| Uploaded file | No API delete endpoint confirmed. Use QA folder naming and request storage cleanup if needed. |

Never clean up seed IDs listed in Section 6 unless the test owner explicitly asks for seed reset validation.

## 9. Auth Endpoints

### Register

```http
POST /api/auth/register
```

Request body:

```json
{
  "email": "qa-20260502@example.com",
  "password": "SeedPassword123",
  "username": "qa20260502"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `email` | string | yes | Valid email |
| `password` | string | yes | Minimum `12`, maximum `128` |
| `username` | string | yes | Minimum `3`, maximum `30` |

Expected:

- Valid unique user returns token, refresh token, and user.
- Duplicate email or username should return conflict or validation error.
- Password shorter than 12 chars should fail.

### Login

```http
POST /api/auth/login
```

Request body:

```json
{
  "email": "author@morneven.com",
  "password": "SeedPassword123"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `email` | string | yes | Valid email |
| `password` | string | yes | Minimum `1`, maximum `128` |

### Refresh Token

```http
POST /api/auth/refresh
```

Request body:

```json
{
  "refreshToken": "<refreshToken>"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `refreshToken` | string | yes | Minimum `10` chars |

### Current User

```http
GET /api/auth/me
```

Expected:

- Valid token returns current user profile.
- Missing token returns `401`.

### Validate Token

```http
GET /api/auth/validate-token
```

Expected:

- Valid token returns success.
- Expired or invalid token returns unauthorized.

### Guest Login

```http
POST /api/auth/guest
```

Expected:

- Returns a guest session if guest auth is enabled.

### Logout

```http
POST /api/auth/logout
```

Expected:

- Valid token logs out current session.

## 10. Navigation Badge Endpoint

```http
GET /api/me/navigation-badges
```

Expected response shape:

```json
{
  "success": true,
  "data": {
    "chat": {
      "unreadTotal": 0,
      "mentions": 0
    },
    "notifications": {
      "unreadTotal": 0
    },
    "management": {
      "pendingRequests": 0
    }
  }
}
```

Expected behavior:

- Requires auth.
- Counts must be scoped to the authenticated user.
- Guest or low-privilege users should not see privileged management counts unless allowed by RBAC.
- Counts should update after chat read, notification read, or management decision actions.

## 11. Chat Endpoints

Chat includes system-managed groups such as institute and division conversations. Backend is authoritative for auto-created groups.

### Reconcile System Groups

```http
POST /api/chat/reconcile
```

Access:

- PL7 user, or PL6 executive user.

Expected:

```json
{
  "success": true,
  "data": {
    "reconciled": true
  }
}
```

Negative:

- Guest or lower-level personnel such as `a.koval` should receive `403`.

### List Conversations

```http
GET /api/chat/conversations
```

Expected:

- Requires auth.
- Automatically reconciles auto-memberships before returning conversations.
- Seed or reconciled conversations should include `conv-institute` for eligible users.

### List Invites

```http
GET /api/chat/invites
```

Expected:

- Returns pending invites for current user.

### List Messages

```http
GET /api/chat/conversations/conv-institute/messages?page=1&pageSize=50
```

Query params:

| Param | Type | Default | Rule |
| --- | --- | --- | --- |
| `page` | integer | `1` | Minimum `1` |
| `pageSize` | integer | `50` | Maximum `100` |

Expected:

- Requires membership in conversation.
- Non-member should receive `403` or `404`.

### Send Message

```http
POST /api/chat/messages
```

Valid body:

```json
{
  "conversationId": "conv-institute",
  "text": "QA-20260502 message test",
  "attachments": []
}
```

Attachment body:

```json
{
  "conversationId": "conv-institute",
  "text": "",
  "attachments": [
    {
      "type": "image",
      "url": "https://example.com/qa-image.png",
      "name": "qa-image.png"
    }
  ]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Non-empty |
| `text` | string | no | Defaults to empty string |
| `attachments` | array of objects | no | Defaults to empty array |
| `replyTo` | object | no | Optional reply reference. Omit the field when there is no reply target. Do not send `null`. |

Important validation:

- At least one of non-empty `text` or non-empty `attachments` is required.

Invalid body:

```json
{
  "conversationId": "conv-institute",
  "text": "",
  "attachments": []
}
```

Expected negative:

- Validation error because text and attachments are both empty.

### Delete Message

```http
DELETE /api/chat/messages/:id
```

Expected:

- Sender or authorized moderator can delete.
- Other users should receive `403`.

### Create DM

```http
POST /api/chat/dm
```

Valid body:

```json
{
  "username": "m.varga"
}
```

Alternative body:

```json
{
  "targetUsername": "m.varga"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `username` or `target` or `targetUsername` | string | yes | Must identify another user |

Negative:

- Targeting self should fail.
- Unknown username should fail.

### Create Manual Group

```http
POST /api/chat/groups
```

Valid body:

```json
{
  "name": "QA-20260502 Group",
  "invitees": ["m.varga", "s.okafor"]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `name` | string | yes | Non-empty |
| `invitees` | string array | yes | Minimum `1` |

### Invite Users To Group

```http
POST /api/chat/conversations/:id/invites
```

Body:

```json
{
  "usernames": ["a.koval"]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `usernames` | string array | yes | Minimum `1` |

Expected:

- Group owner or admin can invite.
- System-managed groups should reject manual invite management.

### Accept Or Reject Invite

```http
POST /api/chat/conversations/:id/invites/accept
```

```http
POST /api/chat/conversations/:id/invites/reject
```

Expected:

- Current user must be invited.
- Accept adds membership.
- Reject removes pending invite.

### Kick Member

```http
POST /api/chat/conversations/:id/kick
```

Body:

```json
{
  "username": "a.koval"
}
```

Expected:

- Owner or admin can kick in manual group.
- System-managed groups should reject manual membership removal.

### Leave Group

```http
POST /api/chat/conversations/:id/leave
```

Expected:

- Manual group member can leave.
- System-managed group leave should be rejected or reconciled back by backend.

### Update Member Role

```http
PUT /api/chat/conversations/:id/member-role
```

Body:

```json
{
  "username": "m.varga",
  "role": "admin"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `username` | string | yes | Non-empty |
| `role` | enum | yes | `owner`, `admin`, `member` |

### Rename Group

```http
PUT /api/chat/conversations/:id/name
```

Body:

```json
{
  "name": "QA-20260502 Renamed Group"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `name` | string | yes | Non-empty |

Expected:

- Manual group owner or admin can rename.
- System-managed group rename should be rejected.

### Mark Conversation Read

```http
POST /api/chat/read
```

Body:

```json
{
  "conversationId": "conv-institute",
  "lastReadAt": "2026-05-02T00:00:00.000Z"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Non-empty |
| `lastReadAt` | string | no | ISO timestamp preferred |

### Unread Counts

```http
GET /api/chat/unread-count
GET /api/chat/unread-counts
```

Expected:

- Counts reflect current user unread state.
- Marking read should reduce count.

## 12. Personnel Endpoints

Access rules vary by level. Use PL7 for full positive testing, and lower-level accounts for RBAC negative testing.

### List Personnel

```http
GET /api/personnel?page=1&pageSize=20&q=field&track=field&level=5
```

Expected:

- Requires auth.
- Returns paginated or list response with personnel visible to current user.

Common filters:

| Param | Type | Rule |
| --- | --- | --- |
| `q` or `search` | string | Search keyword |
| `track` | enum | `executive`, `field`, `mechanic` |
| `level` | integer | `0` to `7` |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Endpoint default applies |

### Create Personnel

```http
POST /api/personnel
```

Valid body:

```json
{
  "username": "qa-personnel-20260502",
  "email": "qa-personnel-20260502@example.com",
  "password": "SeedPassword123",
  "level": 3,
  "track": "mechanic",
  "note": "QA created personnel",
  "role": "personel"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `username` | string | yes | Minimum `3`, maximum `30` |
| `email` | string | yes | Valid email |
| `password` | string | no | Minimum `12`, maximum `128` |
| `level` | integer | no | `0` to `7` |
| `track` | enum | no | Backend Track enum |
| `note` | string | no | Optional |
| `role` | enum | no | `author`, `personel`, `guest` |

Expected:

- PL6 or PL7 can create according to role rules.
- Only PL7 can create PL7 user.
- Duplicate username or email should fail.

Invalid body:

```json
{
  "username": "qa",
  "email": "not-an-email",
  "password": "short",
  "level": 9
}
```

### Update Personnel

```http
PUT /api/personnel/:id
```

Valid body:

```json
{
  "level": 4,
  "track": "mechanic",
  "note": "QA updated personnel"
}
```

Expected:

- PL5 plus may update within allowed scope.
- PL5 is restricted to same track.
- PL7 protected user cannot be modified by non-PL7.

### Bulk Update Personnel

```http
PATCH /api/personnel/bulk
```

Patch body:

```json
{
  "ids": ["user-id-1", "user-id-2"],
  "patch": {
    "note": "QA bulk update"
  }
}
```

Alternative body:

```json
{
  "updates": [
    {
      "id": "user-id-1",
      "note": "QA item update"
    }
  ]
}
```

Expected:

- Requires authorized management level.
- Invalid IDs should fail or return partial failure depending on implementation.

### Delete Personnel

```http
DELETE /api/personnel/:id
```

Expected:

- PL7 only.
- Cannot delete protected PL7 user.

## 13. Management Endpoints

### List Requests

```http
GET /api/management/requests?page=1&pageSize=20&kind=transfer&status=pending&q=QA
```

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Endpoint default applies |
| `q` or `search` | string | Search keyword |
| `kind` | enum | See request kind enum |
| `status` | string | Common values: `pending`, `approved`, `rejected` |
| `requester` | string | Username or requester identifier |

Expected:

- Request visibility is scoped by user level and track.
- Low-privilege users should not see unrelated restricted requests.

### Pending Count

```http
GET /api/management/requests/pending-count
```

Expected:

- Returns pending request count visible to current user.
- Used by sidebar indicator.

### Create Request

```http
POST /api/management/requests
```

Base validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `kind` | enum | yes | `transfer`, `clearance`, `submission_personal`, `submission_team`, `team_change`, `executive_promotion` |
| `payload` | object | no | Defaults to `{}` |
| `reason` | string | yes | Non-empty |

Transfer example:

```json
{
  "kind": "transfer",
  "payload": {
    "targetTrack": "mechanic"
  },
  "reason": "QA-20260502 transfer request"
}
```

Clearance example:

```json
{
  "kind": "clearance",
  "payload": {
    "targetLevel": 4
  },
  "reason": "QA-20260502 clearance request"
}
```

Personal submission example:

```json
{
  "kind": "submission_personal",
  "payload": {
    "gallery": {
      "type": "image",
      "title": "QA-20260502 Personal Submission",
      "thumbnail": "https://example.com/qa.png",
      "caption": "QA personal submission caption",
      "tags": ["qa"]
    }
  },
  "reason": "QA-20260502 personal submission"
}
```

Team submission example:

```json
{
  "kind": "submission_team",
  "payload": {
    "project": {
      "title": "QA-20260502 Team Project",
      "status": "Planning",
      "thumbnail": "https://example.com/project.png",
      "shortDesc": "QA short description",
      "fullDesc": "QA full project description"
    }
  },
  "reason": "QA-20260502 team submission"
}
```

Team change example:

```json
{
  "kind": "team_change",
  "payload": {
    "teamId": "team-seed-ops",
    "action": "add",
    "username": "i.stratos"
  },
  "reason": "QA-20260502 team change"
}
```

Executive promotion example:

```json
{
  "kind": "executive_promotion",
  "payload": {
    "username": "t.bremmer",
    "targetLevel": 6
  },
  "reason": "QA-20260502 executive promotion"
}
```

Invalid body:

```json
{
  "kind": "unknown_kind",
  "reason": ""
}
```

Expected:

- Invalid kind fails validation.
- Empty reason fails validation.
- Created request starts as pending unless workflow changes it.

### Decide Request

```http
POST /api/management/requests/:id/decide
```

Approve body:

```json
{
  "decision": "approved",
  "reviewNote": "QA approved for workflow validation"
}
```

Reject body:

```json
{
  "decision": "rejected",
  "reviewNote": "QA rejected for negative workflow validation"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `decision` | enum | yes | `approved`, `rejected` |
| `reviewNote` | string | no | Optional |

Expected:

- Authorized reviewer can decide.
- Requester should not approve own request if workflow prevents it.
- Approved requests may trigger side effects such as personnel update, gallery item, project item, team update, notification, or chat sync.

### List Teams

```http
GET /api/management/teams
```

Expected:

- Requires auth.
- Returns teams visible to current user.

### Create Team

```http
POST /api/management/teams
```

Body:

```json
{
  "name": "QA-20260502 Team",
  "members": ["i.stratos", "t.bremmer"]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `name` | string | yes | Non-empty |
| `members` | string array | yes | Minimum `1`, maximum `4` |

### Quotas

```http
GET /api/management/quotas/:username
```

Expected:

- Returns quota data for target username if current user has access.

## 14. Project Endpoints

### List Projects

```http
GET /api/projects?page=1&pageSize=20&q=Aethon&status=Planning&archived=false&sort=title
```

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Maximum `100` |
| `limit` | integer | Cursor page size |
| `cursor` | string | Cursor item ID |
| `ids` | comma-separated string | Example `proj-001,proj-002` |
| `q` or `search` | string | Searches project text |
| `archived` | boolean string | `true` or `false` |
| `status` | string | Project status |
| `sort` | enum | `title`, `title-desc`, or default newest |

### Create Project

```http
POST /api/projects
```

Valid body:

```json
{
  "title": "QA-20260502 Project",
  "status": "Planning",
  "thumbnail": "https://example.com/project.png",
  "shortDesc": "QA project short description",
  "fullDesc": "QA project full description with enough detail.",
  "patches": [
    {
      "version": "0.1.0",
      "date": "2026-05-02",
      "notes": "QA patch note"
    }
  ],
  "docs": [
    {
      "type": "image",
      "url": "https://example.com/doc.png",
      "caption": "QA doc image"
    }
  ],
  "archived": false,
  "contributor": "author",
  "meta": {
    "qaRun": "QA-20260502"
  }
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `title` | string | yes | Minimum `1`, maximum `150` |
| `status` | enum | yes | `Planning`, `On Progress`, `OnProgress`, `On Hold`, `OnHold`, `Completed`, `Canceled` |
| `thumbnail` | string | no | Defaults to empty string |
| `shortDesc` | string | yes | Minimum `1`, maximum `500` |
| `fullDesc` | string | yes | Minimum `1` |
| `patches` | array | no | Defaults to `[]` |
| `docs` | array | no | Defaults to `[]` |
| `archived` | boolean | no | Defaults to `false` |
| `contributor` | string | no | Optional username |
| `meta` | object | no | Optional metadata |

Invalid body:

```json
{
  "title": "",
  "status": "BadStatus",
  "shortDesc": "",
  "fullDesc": ""
}
```

### Get, Update, Delete Project

```http
GET /api/projects/proj-001
PUT /api/projects/:id
DELETE /api/projects/:id
```

Expected:

- `GET` returns project by ID.
- `PUT` accepts the same shape as create.
- `DELETE` removes the item if user has permission.
- Unknown ID returns `404`.

## 15. News Endpoints

### List News

```http
GET /api/news?page=1&pageSize=20&q=QA
```

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Endpoint default applies |
| `q` or `search` | string | Search keyword |

### Create News

```http
POST /api/news
```

Valid body:

```json
{
  "text": "QA-20260502 news headline",
  "hasDetail": true,
  "thumbnail": "https://example.com/news.png",
  "body": "QA full news body",
  "publishDate": "2026-05-02T00:00:00.000Z",
  "attachments": [
    {
      "type": "image",
      "url": "https://example.com/news-attachment.png",
      "caption": "QA attachment"
    }
  ]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `text` | string | yes | Minimum `1` |
| `hasDetail` | boolean | no | Defaults to `false` |
| `thumbnail` | string or null | no | Optional |
| `body` | string or null | no | Optional |
| `publishDate` | string | no | ISO timestamp preferred |
| `date` | string | no | Alternative date field |
| `attachments` | array | no | Defaults to `[]` |

Attachment validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `type` | enum | yes | `image`, `video`, `link` |
| `url` | string | yes | Non-empty |
| `caption` | string | no | Optional |

### Get, Update, Delete News

```http
GET /api/news/:id
PUT /api/news/:id
DELETE /api/news/:id
```

Expected:

- Content writer can create and update according to permission rules.
- Unauthorized user receives `403`.

## 16. Lore Endpoints

Categories:

| Category Path | Example Seed ID |
| --- | --- |
| `characters` | `char-001` |
| `places` | `place-001` |
| `technology` | `tech-001` |
| `creatures` | `crea-001` |
| `events` | `evt-001` |
| `other` | `other-001` |

### List Lore

```http
GET /api/lore/characters?page=1&pageSize=20&q=Kael&sort=name-desc
```

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Endpoint default applies |
| `ids` | comma-separated string | Example `char-001,char-002` |
| `q` or `search` | string | Search keyword |
| `sort` | enum | `name-desc` or default ascending |

### Create Lore

```http
POST /api/lore/characters
```

Valid body:

```json
{
  "name": "QA-20260502 Character",
  "shortDesc": "QA character short description",
  "fullDesc": "QA character full description.",
  "image": "https://example.com/character.png",
  "docs": [
    {
      "type": "image",
      "url": "https://example.com/character-doc.png",
      "caption": "QA character document"
    }
  ],
  "metadata": {
    "qaRun": "QA-20260502"
  }
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `name` or `title` | string | yes | Non-empty |
| `shortDesc` | string | yes | Non-empty |
| `fullDesc` | string | yes | Non-empty |
| `image` | string | no | Optional |
| `docs` | array | no | Optional |
| `metadata` | object | no | Optional |

Invalid category:

```http
GET /api/lore/invalid-category
```

Expected:

- Returns `400` or `404` for unsupported category.

### Get, Update, Delete Lore

```http
GET /api/lore/characters/char-001
PUT /api/lore/characters/:id
DELETE /api/lore/characters/:id
```

Expected:

- `GET` seed item returns item detail.
- Writer permissions required for create, update, and delete.
- Unknown ID returns `404`.

## 17. Gallery And Discussion Endpoints

### List Gallery

```http
GET /api/gallery?page=1&pageSize=20&type=image&q=Kael&uploadedBy=author&sort=title
```

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `page` | integer | Minimum `1` |
| `pageSize` | integer | Endpoint default applies |
| `ids` | comma-separated string | Example `gal-001,gal-002` |
| `q` or `search` | string | Search keyword |
| `type` | enum | `image`, `video`, or `All` |
| `uploadedBy` | string | Username |
| `sort` | enum | `oldest`, `title`, or default newest |

### Create Gallery Item

```http
POST /api/gallery
```

Valid body:

```json
{
  "type": "image",
  "title": "QA-20260502 Gallery Item",
  "thumbnail": "https://example.com/gallery.png",
  "videoUrl": "",
  "caption": "QA gallery caption",
  "tags": ["qa", "smoke"],
  "date": "2026-05-02",
  "uploadedBy": "author"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `type` | enum | no | `image` or `video`, defaults to `image` |
| `title` | string | yes | Minimum `1`, maximum `160` |
| `thumbnail` | string | no | Defaults to empty string |
| `videoUrl` | string | no | Optional |
| `caption` | string | yes | Minimum `1` |
| `tags` | string array | no | Defaults to `[]` |
| `date` | string | no | Optional |
| `uploadedBy` | string | no | Optional |

Invalid body:

```json
{
  "type": "audio",
  "title": "",
  "caption": ""
}
```

### Get, Update, Delete Gallery Item

```http
GET /api/gallery/gal-001
PUT /api/gallery/:id
DELETE /api/gallery/:id
```

Expected:

- Owner or PL7 can update and delete.
- Other users should receive `403`.

### Comments

```http
GET /api/gallery/:id/comments
POST /api/gallery/:id/comments
DELETE /api/gallery/:id/comments/:commentId
```

Create comment body:

```json
{
  "text": "QA-20260502 gallery comment"
}
```

Expected:

- Authenticated user can comment if discussion is enabled.
- Empty `text` should fail validation or be rejected by service.

### Replies

```http
POST /api/gallery/:id/comments/:commentId/replies
DELETE /api/gallery/:id/comments/:commentId/replies/:replyId
```

Create reply body:

```json
{
  "text": "QA-20260502 gallery reply"
}
```

Expected:

- Authenticated user can reply to an existing comment.
- Unknown `commentId` returns `404`.

## 18. Map Endpoints

### Get Markers And Image

```http
GET /api/map/markers
GET /api/map/image
```

Expected:

- Requires auth.
- Returns current map marker set and image.

### Update Markers

```http
PUT /api/map/markers
```

Valid body:

```json
{
  "markers": [
    {
      "id": "qa-marker-20260502",
      "name": "QA Marker",
      "status": "safe",
      "x": 0.35,
      "y": 0.45,
      "description": "QA map marker",
      "loreLink": "place-001"
    }
  ]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `markers` | array | yes | Array of marker objects |
| `id` | string | no | Optional |
| `name` | string | yes | Non-empty |
| `status` | enum | yes | `safe`, `caution`, `danger`, `restricted`, `mission` |
| `x` | number | yes | Minimum `0`, maximum `1` |
| `y` | number | yes | Minimum `0`, maximum `1` |
| `description` | string | yes | Non-empty |
| `loreLink` | string | no | Optional |

Invalid body:

```json
{
  "markers": [
    {
      "name": "Invalid Marker",
      "status": "active",
      "x": 2,
      "y": -1,
      "description": "Invalid coordinates"
    }
  ]
}
```

Expected:

- PL7 or PL6 executive can update.
- Lower-level user receives `403`.
- Invalid coordinates or invalid status values fail validation with `422`.

### Update Map Image

```http
PUT /api/map/image
```

Body:

```json
{
  "imageUrl": "https://example.com/qa-map.png"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `imageUrl` | string | yes | Non-empty |

## 19. Notification Endpoints

### List Notifications

```http
GET /api/notifications
```

Expected:

- Requires auth.
- Returns notifications for current user.

### Unread Count

```http
GET /api/notifications/unread-count
```

Expected:

- Returns unread count for current user.
- Used by sidebar indicator.

### Create Notification

```http
POST /api/notifications
```

Access:

- PL7 only.

Valid body:

```json
{
  "kind": "info",
  "title": "QA-20260502 Notification",
  "body": "QA notification body",
  "recipient": "author",
  "sender": "author",
  "link": "/command-center"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `kind` | enum | no | `info`, `warning`, `system`, `mention`, `request`, defaults to `info` |
| `title` | string | yes | Non-empty |
| `body` | string | no | Optional |
| `recipient` | string | yes | Non-empty |
| `sender` | string | no | Optional |
| `link` | string | no | Optional |

### Mark Read And Delete

```http
POST /api/notifications/:id/read
POST /api/notifications/read-all
DELETE /api/notifications/:id
```

Expected:

- Only current user's notification should be readable or deletable.
- Read action should reduce unread count.

## 20. Settings And Extraction Endpoints

Settings endpoints are PL7-only unless otherwise stated.

### Get Command Center Settings

```http
GET /api/settings/command-center
```

Expected:

- Returns current command-center configuration.

### Update Command Center Settings

```http
PUT /api/settings/command-center
```

Valid body:

```json
{
  "showStats": true,
  "showProjects": true,
  "showNews": true,
  "showCharacters": true,
  "showPlaces": true,
  "showTechnology": true,
  "showGallery": true,
  "showQuickActions": true,
  "welcomeMessage": "QA command center message",
  "itemLimits": {
    "projects": 6,
    "news": 6
  },
  "manualSelections": {
    "projects": ["proj-001", "proj-002"]
  }
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `showStats` | boolean | no | Optional |
| `showProjects` | boolean | no | Optional |
| `showNews` | boolean | no | Optional |
| `showCharacters` | boolean | no | Optional |
| `showPlaces` | boolean | no | Optional |
| `showTechnology` | boolean | no | Optional |
| `showGallery` | boolean | no | Optional |
| `showQuickActions` | boolean | no | Optional |
| `welcomeMessage` | string | no | Maximum `300` |
| `itemLimits` | object | no | Integer values `0` to `100` |
| `manualSelections` | object | no | Values are string arrays |

### Start Extraction Job

```http
POST /api/settings/extractions
```

Valid body:

```json
{
  "mode": "db",
  "autoDownload": false,
  "confirmText": "CONFIRM",
  "password": "SeedPassword123"
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `mode` | enum | yes | `db`, `images`, `all` |
| `autoDownload` | boolean | no | Defaults to `false` |
| `confirmText` | string | yes | Must be `CONFIRM` |
| `password` | string | yes | Non-empty current user password |

Expected:

- Valid request returns `202` with extraction job ID.
- Invalid `confirmText` fails validation.
- Wrong password fails authorization.

### Poll Extraction Job

```http
GET /api/settings/extractions/:id
```

Expected progress fields:

```json
{
  "success": true,
  "data": {
    "id": "job-id",
    "status": "queued",
    "progress": 0,
    "mode": "db",
    "downloadUrl": null
  }
}
```

QA should poll until terminal status such as completed or failed. Recommended interval is `2` to `5` seconds to avoid unnecessary load.

### Download Extraction Result

```http
GET /api/settings/extractions/:id/download
```

Expected:

- Completed job returns downloadable archive or redirects to storage URL.
- Non-completed job returns an error.

### Clear Extraction Jobs

```http
DELETE /api/settings/extractions
```

Body:

```json
{
  "ids": ["job-id-1", "job-id-2"]
}
```

Validation:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `ids` | string array | no | If omitted, backend may clear according to service behavior |

## 21. File Upload Endpoint

```http
POST /api/files/upload?folder=gallery
```

Multipart form fields:

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `file` | file | yes | Maximum size from `MAX_UPLOAD_MB` |

Query params:

| Param | Type | Rule |
| --- | --- | --- |
| `folder` | enum | `gallery`, `lore`, `projects`, `news`, `map`, `chat`, `exports`, `uploads` |

Example curl:

```bash
curl -X POST "https://backend.dev.morneven.com/api/files/upload?folder=gallery" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./qa-image.png"
```

Expected:

- Valid upload returns file metadata or URL.
- Missing file returns validation error.
- Oversized file returns upload size error.
- Unsupported folder should fail validation or fall back only if explicitly implemented.

## 22. QA Smoke Test Priority

Run in this order before deeper functional testing:

1. `GET /health`
2. `GET /ready`
3. `POST /api/auth/login` with `author@morneven.com`
4. `GET /api/auth/me`
5. `GET /api/projects?page=1&pageSize=5`
6. `GET /api/news?page=1&pageSize=5`
7. `GET /api/lore/characters?page=1&pageSize=5`
8. `GET /api/gallery?page=1&pageSize=5`
9. `GET /api/chat/conversations`
10. `GET /api/me/navigation-badges`
11. `GET /api/notifications/unread-count`
12. `GET /api/management/requests/pending-count` with PL7

Minimum pass criteria:

- Health and readiness return `200`.
- Login returns token.
- Protected endpoints reject missing token with `401`.
- PL7-only endpoint rejects non-PL7 user with `403`.
- Priority list endpoints do not return `500`.

## 23. Full Functional QA Order

Recommended test order:

1. Auth positive and negative tests.
2. Read-only list endpoints with pagination, search, filter, and sorting.
3. RBAC checks with `guest_visitor`, `author`, `v.kessler`, `m.varga`, `s.okafor`, and `a.koval`.
4. Create QA content records for projects, news, lore, and gallery.
5. Update QA-created records.
6. Discussion flow on QA-created gallery item.
7. Chat DM and manual group flow.
8. System-managed chat group behavior and reconcile endpoint.
9. Management request creation and decision workflow.
10. Notification count and read-state workflow.
11. File upload with small safe test image.
12. Extraction job only if explicitly approved.
13. Cleanup of QA-created records where supported.

## 24. Negative Testing Checklist

Run representative negative tests for each module:

| Case | Expected |
| --- | --- |
| Missing token on protected endpoint | `401` |
| Invalid token | `401` |
| Insufficient role or level | `403` |
| Unknown ID | `404` |
| Invalid enum | Validation error |
| Missing required field | Validation error |
| Wrong field type | Validation error |
| Empty string for required text | Validation error |
| Oversized page size | Cap or validation error |
| Invalid upload folder | Validation error |
| Wrong extraction password | Authorization error |
| Repeated failed login | Eventually `429` |

## 25. Known Constraints

- No dedicated public build or version endpoint exists yet.
- No API endpoint is confirmed for deleting uploaded files from storage.
- Chat manual groups do not have a hard-delete endpoint.
- Management requests do not have a hard-delete endpoint.
- Extraction jobs should be tested carefully because they may create archive files.
- Some payload side effects are workflow-dependent, especially management approvals.
- The exact Railway environment variables are not visible from this document. QA should capture actual response headers and health payload during execution.

## 26. Recommended QA Report Fields

For every test run, capture:

- Date and timezone.
- Base URL and API prefix.
- Account email and role used.
- Endpoint, method, request body, and query params.
- HTTP status.
- Response body.
- Expected result.
- Actual result.
- Pass or fail.
- Created record IDs.
- Cleanup status.
