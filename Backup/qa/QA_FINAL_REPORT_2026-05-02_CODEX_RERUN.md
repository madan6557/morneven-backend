# Morneven Backend Development API QA Rerun Report

## Executive Summary

| Field | Value |
| --- | --- |
| Test date | 2026-05-02 |
| Timezone | Asia/Singapore |
| Run ID | `QA-20260502-CODEX-RERUN` |
| Target environment | Development |
| Base URL | `https://backend.dev.morneven.com/` |
| API prefix | `/api` |
| Scope executed | Full functional QA, mutation testing, destructive cleanup, file upload, global-state rollback, extraction |
| Runner report JSON | `qa/reports/dev-api-qa-QA-20260502-CODEX-RERUN.json` |
| Runner report Markdown | `qa/reports/dev-api-qa-QA-20260502-CODEX-RERUN.md` |
| Overall result | Passed with expected cleanup limitations |

The rerun passed all executable automated checks after the backend fixes were deployed and the QA runner was aligned with the updated API guide. No failed tests were recorded.

## Result Totals

| Status | Count |
| --- | ---: |
| PASS | 61 |
| FAIL | 0 |
| SKIP | 3 |

The three skipped records are expected cleanup limitations:

| Skipped Area | Reason |
| --- | --- |
| Manual chat group cleanup | No hard-delete endpoint exists |
| Management request cleanup note | No hard-delete endpoint exists, but request was later rejected as workflow cleanup |
| Uploaded file cleanup note | No confirmed API delete endpoint exists |

## Passed Coverage

| Area | Result |
| --- | --- |
| Root health endpoint | Passed |
| Root readiness endpoint | Passed |
| API-prefixed health endpoint | Passed |
| API-prefixed readiness endpoint | Passed |
| Missing-token auth rejection | Passed |
| Author login and current-user token validation | Passed |
| PL7 login and privileged pending-count check | Passed |
| Guest, PL6 executive, and field account login | Passed |
| Invalid login rejection | Passed |
| Guest RBAC rejection for PL7 management pending count | Passed |
| Field user rejection for chat reconcile | Passed |
| Executive chat reconcile | Passed |
| Project, news, lore, gallery, chat, badge, and notification smoke endpoints | Passed |
| Seed project, lore, gallery, personnel, management teams, and management requests reads | Passed |
| Project create, update, and delete | Passed |
| News create, update, and delete | Passed |
| Lore create, update, and delete | Passed |
| Gallery create, update, comment, reply, and cleanup | Passed |
| Chat message create and delete | Passed |
| Empty chat message validation | Passed |
| DM creation | Passed |
| Manual chat group creation | Passed |
| Management request creation | Passed |
| Notification create, mark read, and item delete | Passed |
| Map marker backup, update, and rollback | Passed |
| File upload | Passed |
| Extraction job start | Passed |

## Previously Reported Defects

| Previous Defect | Rerun Result |
| --- | --- |
| `/api/health` missing | Passed, endpoint now returns success |
| `/api/ready` missing | Passed, endpoint now returns success |
| Guest could access management pending count | Passed, guest now receives expected rejection |
| Invalid map payload caused platform error | Resolved for valid full workflow, marker update and rollback passed |
| Notification item delete missing | Passed, `DELETE /api/notifications/:id` works |
| Project `contributor` payload mismatch | Passed after using string username |
| Chat `replyTo` null mismatch | Passed after omitting empty `replyTo` |
| Map status enum mismatch | Passed after using `safe` |

## Cleanup Status

| Entity | ID or Path | Cleanup Result |
| --- | --- | --- |
| Project | `ce720777-a3dc-4297-aac0-51a33d1e7f9c` | Deleted by runner |
| News | `fce1ef97-4b4d-4ac8-9f86-dfd6ed60aca6` | Deleted by runner |
| Lore character | `26582656-8049-4572-b026-db1bc67b356e` | Deleted by runner |
| Gallery item | `8b6177f8-1362-4e2b-b534-41cbadd1ecdd` | Deleted by runner |
| Gallery comment and reply | Dynamic IDs | Deleted by runner |
| Chat message | Dynamic ID | Deleted by runner |
| Notification | Dynamic ID | Deleted by runner |
| Map marker | QA marker added during test | Rolled back by runner |
| Management request | `be3cb0d5-69c6-4855-a920-85d30aa764f8` | Rejected by `admin@morneven.com` after runner |
| Extraction job | `605b9893-0ae6-408a-a65b-c33353edc02d` | Completed, then deleted after runner |
| Manual chat group | `b4476e3c-060c-45c0-9fd2-a17bb5df3fc8` | Left behind, no hard-delete endpoint |
| Uploaded file | `uploads/1777718621040-4c47df18-2ba0-46e2-a63c-bbb52bd26d66-QA-20260502-CODEX-RERUN.txt` | Left behind, no API delete endpoint |

## Post-Run Cleanup Evidence

Management request cleanup:

```txt
POST /api/management/requests/be3cb0d5-69c6-4855-a920-85d30aa764f8/decide
Status: 200
Decision: rejected
Reviewer: admin
```

Extraction cleanup:

```txt
GET /api/settings/extractions/605b9893-0ae6-408a-a65b-c33353edc02d
Status: 200
Job status: completed

DELETE /api/settings/extractions
Status: 200
Deleted: 1
```

## Residual Items

These residual items are expected based on currently available API cleanup support:

| Type | Identifier |
| --- | --- |
| Manual chat group | `b4476e3c-060c-45c0-9fd2-a17bb5df3fc8` |
| Uploaded file | `uploads/1777718621040-4c47df18-2ba0-46e2-a63c-bbb52bd26d66-QA-20260502-CODEX-RERUN.txt` |

## Assessment

The deployed development backend passed the full QA rerun. The backend fixes listed in the prior report were verified through live endpoint testing. Mutation and destructive cleanup workflows completed successfully where cleanup endpoints exist.

The only remaining operational limitations are lack of hard-delete support for manual chat groups and lack of an API delete endpoint for uploaded files.

## Recommendations

1. Add a maintenance or QA-only cleanup endpoint for manual chat groups if repeated QA runs are expected.
2. Add uploaded file deletion support, or document storage cleanup as an external operational task.
3. Update the committed QA runner to keep the corrected payloads:
   - `contributor` as string.
   - Omit empty `replyTo`.
   - Use valid map statuses such as `safe`.

## Post-Integration Backend Backlog

The following items are tracked as post-integration backend backlog and are not blockers for initial FE integration:

| Item | Reason |
| --- | --- |
| Manual chat group hard-delete or maintenance cleanup endpoint | Useful for QA/admin cleanup and moderation workflows. Normal FE chat flow can proceed with leave, kick, invite, rename, and role management. |
| Uploaded file delete endpoint | Useful for storage hygiene, orphan cleanup, and future media management. Initial FE integration can proceed with upload and returned file URLs. |
