# Morneven Backend Development API QA Report

## Executive Summary

| Field | Value |
| --- | --- |
| Test date | 2026-05-02 |
| Timezone | Asia/Singapore |
| Primary run ID | `QA-20260502-CODEX-FULL` |
| Target environment | Development |
| Base URL | `https://backend.dev.morneven.com/` |
| API prefix | `/api` |
| Scope executed | Full functional QA, mutation testing, destructive cleanup, file upload, global-state rollback, extraction |
| Runner report JSON | `qa/reports/dev-api-qa-QA-20260502-CODEX-FULL.json` |
| Runner report Markdown | `qa/reports/dev-api-qa-QA-20260502-CODEX-FULL.md` |
| Overall result | Failed with defects and documentation or runner mismatches |

The development API is reachable from the QA environment. Core health, readiness, authentication, read-only content lists, RBAC login coverage, most CRUD flows, gallery discussion flows, chat group creation, management request creation, notification creation/read, and extraction cleanup were validated.

The full automated run produced `48` passes, `10` failures, and `3` skips. Targeted retests confirmed that several failures were caused by outdated payloads in the QA runner rather than backend endpoint failure.

## Connectivity

| Check | Result |
| --- | --- |
| DNS resolution | Passed |
| TCP `443` connectivity | Passed |
| `GET /health` | `200` |
| `GET /ready` | `200` |

Observed health response:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "env": "development"
  }
}
```

Observed readiness response:

```json
{
  "success": true,
  "data": {
    "status": "ready"
  }
}
```

## Automated Run Totals

| Status | Count |
| --- | ---: |
| PASS | 48 |
| FAIL | 10 |
| SKIP | 3 |

## Passed Coverage

The following areas passed in the automated run:

| Area | Result |
| --- | --- |
| Root health and readiness | Passed |
| Missing-token auth rejection | Passed |
| Login as `author`, `guest`, `v.kessler`, and `m.varga` | Passed |
| Current user profile with token | Passed |
| Invalid login rejection | Passed |
| PL7 pending management count | Passed |
| PL6 field user denied chat reconcile | Passed |
| PL6 executive or PL7 chat reconcile | Passed |
| Projects, news, lore, gallery smoke lists | Passed |
| Chat conversations smoke list | Passed |
| Navigation badges and notification unread count | Passed |
| Seed project detail lookup | Passed |
| Unknown news ID returns `404` | Passed |
| Seed lore and gallery detail lookup | Passed |
| Invalid lore category returns expected error | Passed |
| Personnel list | Passed |
| Management teams and requests list | Passed |
| News create, update, and delete | Passed |
| Lore create, update, and delete | Passed |
| Gallery create, update, comment, reply, and cleanup | Passed |
| Empty chat message validation | Passed |
| DM creation | Passed |
| Manual chat group creation | Passed |
| Management request creation | Passed |
| Notification create and mark-read | Passed |

## Confirmed Defects

### D-001: `/api/health` is not mounted

| Field | Value |
| --- | --- |
| Severity | Medium |
| Method | `GET` |
| Endpoint | `/api/health` |
| Expected | `200` with health payload |
| Actual | `404` |
| Response | `Route not found`, `errorCode=NOT_FOUND` |

Root `/health` works, but `/api/health` does not. The QA guide expects the API-prefixed route to exist.

### D-002: `/api/ready` is not mounted

| Field | Value |
| --- | --- |
| Severity | Medium |
| Method | `GET` |
| Endpoint | `/api/ready` |
| Expected | `200` with readiness payload |
| Actual | `404` |
| Response | `Route not found`, `errorCode=NOT_FOUND` |

Root `/ready` works, but `/api/ready` does not. Implementation and documentation need to be aligned.

### D-003: Guest can access PL7 management pending-count endpoint

| Field | Value |
| --- | --- |
| Severity | High |
| Method | `GET` |
| Endpoint | `/api/management/requests/pending-count` |
| Account | `guest@morneven.com` |
| Expected | `401` or `403` |
| Actual | `200` |
| Response | `{ "success": true, "data": { "count": 0 } }` |

The guest account can access a privileged management count endpoint. If this count is intended to be privileged, this is an RBAC defect.

### D-004: Invalid map marker status causes `502` instead of validation error

| Field | Value |
| --- | --- |
| Severity | High |
| Method | `PUT` |
| Endpoint | `/api/map/markers` |
| Invalid field | `status: "active"` |
| Expected | `400` or `422` validation error |
| Actual | `502 Application failed to respond` |

The route validates coordinates and name, but does not validate `status` against the `MapStatus` enum before writing through Prisma. A valid marker status such as `safe` passes, and rollback passes. Invalid enum values should return a controlled validation error instead of surfacing as a platform `502`.

### D-005: Notification single-record delete route is documented but not implemented

| Field | Value |
| --- | --- |
| Severity | Medium |
| Method | `DELETE` |
| Endpoint | `/api/notifications/:id` |
| Expected | Delete one notification |
| Actual | `404 Route not found` |

The implementation supports `DELETE /api/notifications`, which deletes current-user notifications in bulk. It does not support `DELETE /api/notifications/:id`, but the QA guide and cleanup plan expect item-level deletion.

## Documentation Or Runner Mismatches Confirmed By Retest

### M-001: Project `contributor` is a string, not an object

Automated runner payload:

```json
{
  "contributor": {
    "username": "author"
  }
}
```

Automated result:

```txt
422 Validation failed: contributor expected string, received object
```

Targeted retest payload:

```json
{
  "contributor": "author"
}
```

Targeted retest result:

| Step | Result |
| --- | --- |
| Create project | `201` |
| Update project | `200` |
| Delete project | `200` |

Conclusion: the backend behavior is valid, but the QA guide or runner payload must be updated.

### M-002: Chat `replyTo` must be omitted when empty

Automated runner payload included:

```json
{
  "replyTo": null
}
```

Automated result:

```txt
422 Validation failed: replyTo expected object, received null
```

Targeted retest omitted `replyTo`.

| Step | Result |
| --- | --- |
| Send chat message | `201` |
| Delete chat message | `200` |

Conclusion: the API works when `replyTo` is omitted. The QA runner should not send `replyTo: null`.

### M-003: Map marker valid enum values are `safe`, `caution`, `danger`, `restricted`, and `mission`

Automated runner used:

```json
{
  "status": "active"
}
```

Targeted retest used:

```json
{
  "status": "safe"
}
```

| Step | Result |
| --- | --- |
| Backup markers | `200` |
| Update markers with QA marker | `200` |
| Rollback markers | `200` |

Conclusion: update and rollback work with valid enum values. Invalid enum handling still needs a controlled validation response.

## Transient Or Retested Areas

### File Upload

The automated runner initially received `502 Application failed to respond` for upload after the invalid map request sequence.

Targeted retest:

| Field | Value |
| --- | --- |
| Method | `POST` |
| Endpoint | `/api/files/upload?folder=uploads` |
| Result | `200` |
| Uploaded object | `uploads/1777717476768-c2c8d607-9f7e-4a39-8777-69221227af62-QA-20260502-CODEX-RETEST.txt` |

Conclusion: upload works in isolation. There is no confirmed API cleanup endpoint for uploaded files.

### Extraction

The automated runner initially received `502 Application failed to respond` for extraction after the invalid map request sequence.

Targeted retest:

| Step | Result |
| --- | --- |
| Start DB extraction | `202` |
| Poll extraction job | `200`, completed |
| Cleanup extraction job | `200`, deleted `1` |

Extraction job ID:

```txt
a548777e-b9a1-4b74-b5cd-22d47defc49a
```

Conclusion: extraction works in isolation and cleanup works.

## Cleanup Status

| Entity | Status |
| --- | --- |
| QA news record | Created, updated, deleted |
| QA lore record | Created, updated, deleted |
| QA gallery item | Created, updated, deleted |
| QA gallery comment | Created, deleted |
| QA gallery reply | Created, deleted |
| QA project retest record | Created, updated, deleted |
| QA chat message retest | Created, deleted |
| QA map marker retest | Created, rolled back |
| QA extraction job retest | Created, completed, deleted |
| QA management request | Created, then rejected by `admin@morneven.com` |
| QA notification | Created and marked read, item-level delete route unavailable |
| QA manual chat group | Left behind because no hard-delete endpoint exists |
| QA uploaded file | Left in local storage because no API delete endpoint exists |

Residual records or artifacts:

| Type | Identifier |
| --- | --- |
| Manual chat group | `f73e0f3f-b14f-45f2-be48-0bf3ee4bd038` |
| Notification | `882d648f-9209-4203-8374-e910194cc65d` |
| Uploaded file | `uploads/1777717476768-c2c8d607-9f7e-4a39-8777-69221227af62-QA-20260502-CODEX-RETEST.txt` |

The management request `199a63b3-7928-4e8c-afe2-b1b6e52db3fb` was rejected as cleanup.

## Overall Assessment

The development backend is functional for the majority of tested API behavior. Core auth, read-only content access, most mutation workflows, destructive cleanup for supported entities, discussion workflows, chat creation, global map update and rollback with valid payloads, file upload, and extraction lifecycle all work.

The main backend defects are missing API-prefixed health/readiness routes, overly permissive guest access to a management count endpoint, unhandled invalid map status causing `502`, and missing item-level notification deletion despite documentation expecting it.

The QA guide and runner should be updated for project `contributor`, chat `replyTo`, and map `status` enum values.

## Recommended Fixes

1. Add or remove `/api/health` and `/api/ready` from the contract.
2. Restrict `GET /api/management/requests/pending-count` for guest users if management counts are privileged.
3. Validate map marker `status` before Prisma writes and return `422` for invalid values.
4. Either implement `DELETE /api/notifications/:id` or update the guide to document only bulk delete.
5. Update QA payloads:
   - `project.contributor` should be a string.
   - Omit `replyTo` when there is no reply target.
   - Use valid map statuses only.
6. Add cleanup endpoints for manual chat groups and uploaded files if repeated QA runs are expected.

## Backend Fix Update

| Field | Value |
| --- | --- |
| Fix date | 2026-05-02 |
| Implemented by | Codex |
| Verification | `npm.cmd run build`, `npx.cmd prisma validate`, `git diff --check` |

### Fixed Defects

| Defect | Status | Change |
| --- | --- | --- |
| D-001 `/api/health` missing | Fixed | Added `/api/health` and `/v1/health` alongside root `/health`. |
| D-002 `/api/ready` missing | Fixed | Added `/api/ready` and `/v1/ready` alongside root `/ready`. |
| D-003 guest access to management pending count | Fixed | `GET /api/management/requests/pending-count` now rejects level `0` users with `403`. |
| D-004 invalid map marker status causes platform error | Fixed | `PUT /api/map/markers` now validates marker payloads with Zod and returns `422` for invalid `MapStatus`, coordinates, or missing names. |
| D-005 notification item delete missing | Fixed | Added `DELETE /api/notifications/:id` for current-user notifications. Broadcast notifications are hidden for the current user through read-state rather than hard-deleted globally. |

### Documentation Fixes

| Mismatch | Status | Change |
| --- | --- | --- |
| M-001 project contributor payload | Fixed | QA guide now documents `contributor` as a string username. |
| M-002 chat empty `replyTo` payload | Fixed | QA guide now instructs QA to omit `replyTo` when no reply target exists. |
| M-003 map status enum values | Fixed | QA guide now uses `safe` in valid examples and lists valid values: `safe`, `caution`, `danger`, `restricted`, `mission`. |

### Verification Notes

Build and static validation passed locally after the fixes:

```txt
npm.cmd run build
npx.cmd prisma validate
git diff --check -- src/server.ts src/modules/management/router.ts src/modules/map/router.ts src/modules/notifications/router.ts
```

No live Railway retest was run in this fix pass. QA should rerun the failed cases against the deployed environment after the backend is redeployed.
