# Frontend Integration Notes

Last updated: 2026-05-02

Backend QA rerun `QA-20260502-CODEX-RERUN` passed with `61` pass, `0` fail, and `3` expected cleanup skips.

## Base URL

Use the development backend for FE integration:

```txt
https://backend.dev.morneven.com
```

Default API prefix:

```txt
/api
```

Example:

```txt
https://backend.dev.morneven.com/api/auth/login
```

## Auth Contract

Login response uses `data.token`.

```json
{
  "success": true,
  "data": {
    "token": "jwt-token",
    "refreshToken": "refresh-token",
    "user": {
      "id": "psn-001",
      "username": "author",
      "email": "author@morneven.com",
      "role": "author",
      "level": 7,
      "track": "executive"
    }
  }
}
```

Do not read `data.accessToken`.

Protected requests must use:

```http
Authorization: Bearer <token>
```

## Payload Notes

Project create and update:

```json
{
  "title": "Example Project",
  "status": "Planning",
  "shortDesc": "Short description",
  "fullDesc": "Full description",
  "contributor": "author"
}
```

`contributor` must be a string username, not an object.

Chat message without reply:

```json
{
  "conversationId": "conv-institute",
  "text": "Message body",
  "attachments": []
}
```

Omit `replyTo` when there is no reply target. Do not send `replyTo: null`.

Map marker statuses:

```txt
safe
caution
danger
restricted
mission
```

Invalid values return validation error.

## Known Integration Constraints

- Manual chat groups do not have a hard-delete endpoint.
- Uploaded files do not have an API delete endpoint.
- REST is the baseline for initial FE integration.
- WebSocket is available at `/ws/chat`, but FE can start with REST and polling where needed.
- System-managed chat groups are backend-owned. FE should read them from `GET /api/chat/conversations`, not create institute, division, or team groups manually.

## Post-Integration Backend Backlog

These items are not blockers for initial FE integration:

| Item | Priority | Reason |
| --- | --- | --- |
| Manual chat group hard-delete or maintenance cleanup endpoint | Backlog | Needed for QA/admin cleanup and moderation tooling, not normal user chat flow. Current FE can use leave, kick, invite, rename, and role management. |
| Uploaded file delete endpoint | Backlog | Needed for storage hygiene, orphan cleanup, and future media management. Initial FE integration can upload and persist returned file URLs without delete support. |

## QA References

- `qa/reports/dev-api-qa-QA-20260502-CODEX-RERUN.md`
- `qa/QA_FINAL_REPORT_2026-05-02_CODEX_RERUN.md`
