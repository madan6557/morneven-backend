# Morneven Backend Development API QA Report

## Executive Summary

| Field | Value |
| --- | --- |
| Test date | 2026-05-02 |
| Run ID | `QA-25244592053-1` |
| Source artifact | `qa/dev-api-qa-report-25244592053-1.zip` |
| Target environment | Development |
| Base URL | `https://backend.dev.morneven.com/` |
| API prefix | `/api` |
| Scope requested | Full QA |
| Destructive cleanup enabled | `true` |
| Global-state tests enabled | `false` |
| File upload tests enabled | `true` |
| Extraction tests enabled | `false` |
| Started | `2026-05-02T05:17:43.681Z` |
| Ended | `2026-05-02T05:17:48.883Z` |
| Overall result | Failed, full QA not completed |

The CI runner successfully reached the development backend and executed the initial smoke and authentication checks. The run did not reach mutation, destructive cleanup, RBAC, CRUD, file upload, or full functional suites because the required PL7 account login failed.

## Result Totals

| Status | Count |
| --- | ---: |
| PASS | 12 |
| FAIL | 4 |
| BLOCKED | 0 |
| SKIP | 0 |

## Passed Tests

| Suite | Test | Method | Endpoint | HTTP |
| --- | --- | --- | --- | ---: |
| Smoke | Root health endpoint | `GET` | `/health` | 200 |
| Smoke | Root readiness endpoint | `GET` | `/ready` | 200 |
| Auth | Protected current user rejects missing token | `GET` | `/api/auth/me` | 401 |
| Auth | Login as author | `POST` | `/api/auth/login` | 200 |
| Auth | Current user accepts author token | `GET` | `/api/auth/me` | 200 |
| Smoke | Projects list | `GET` | `/api/projects?page=1&pageSize=5` | 200 |
| Smoke | News list | `GET` | `/api/news?page=1&pageSize=5` | 200 |
| Smoke | Characters lore list | `GET` | `/api/lore/characters?page=1&pageSize=5` | 200 |
| Smoke | Gallery list | `GET` | `/api/gallery?page=1&pageSize=5` | 200 |
| Smoke | Chat conversations | `GET` | `/api/chat/conversations` | 200 |
| Smoke | Navigation badges | `GET` | `/api/me/navigation-badges` | 200 |
| Smoke | Notification unread count | `GET` | `/api/notifications/unread-count` | 200 |

## Failed Tests

### F-001: API-prefixed health endpoint is not mounted

| Field | Value |
| --- | --- |
| Suite | Smoke |
| Test | API health endpoint |
| Method | `GET` |
| Endpoint | `/api/health` |
| Expected | `200` and `success: true` |
| Actual | `404` |
| Response | `Route not found`, `errorCode=NOT_FOUND` |
| Severity | Medium |

The QA guide expects `/api/health` to behave like `/health`, but the backend returned `404`. Either the endpoint is not mounted under `/api`, or the QA guide expectation is incorrect.

### F-002: API-prefixed readiness endpoint is not mounted

| Field | Value |
| --- | --- |
| Suite | Smoke |
| Test | API readiness endpoint |
| Method | `GET` |
| Endpoint | `/api/ready` |
| Expected | `200` and `success: true` |
| Actual | `404` |
| Response | `Route not found`, `errorCode=NOT_FOUND` |
| Severity | Medium |

The root readiness endpoint `/ready` works, but `/api/ready` is not available. The implementation and QA documentation need to be aligned.

### F-003: PL7 seed account login failed

| Field | Value |
| --- | --- |
| Suite | Auth |
| Test | Login as exec7 |
| Method | `POST` |
| Endpoint | `/api/auth/login` |
| Expected | `200` and access token returned |
| Actual | `401` |
| Response | `Invalid credentials`, `errorCode=UNAUTHORIZED` |
| Severity | High |

The configured PL7 account `exec7@morneven.com` with the documented seed password did not authenticate. This blocked all tests requiring PL7 privileges, including management, privileged RBAC, notifications, and some cleanup paths.

### F-004: QA runner stopped after missing PL7 token

| Field | Value |
| --- | --- |
| Suite | Runner |
| Test | Unhandled runner error |
| Expected | Runner completes without unhandled errors |
| Actual | `Error: Login did not return a token for exec7` |
| Severity | High |

The runner stopped after the PL7 login failure. This prevented the remaining full QA suites from executing. The runner should continue with non-PL7 suites where possible and report privileged suites as blocked instead of terminating the run.

## Not Executed Due To Early Stop

The following requested areas were not executed because the PL7 login failure stopped the runner:

| Area | Status | Reason |
| --- | --- | --- |
| Full RBAC matrix | Not executed | Requires additional seed account logins after PL7 phase |
| Project create, update, delete | Not executed | Runner stopped before mutation suite |
| News create, update, delete | Not executed | Runner stopped before mutation suite |
| Lore create, update, delete | Not executed | Runner stopped before mutation suite |
| Gallery create, update, delete | Not executed | Runner stopped before mutation suite |
| Gallery comments and replies | Not executed | Runner stopped before discussion suite |
| Chat DM and manual group flow | Not executed | Runner stopped before chat flow |
| Chat reconcile | Not executed | Requires executive token |
| Personnel mutation and destructive checks | Not executed | Requires privileged token |
| Management request workflow | Not executed | Requires privileged token |
| Notification create/read/delete workflow | Not executed | Requires PL7 token |
| File upload | Not executed | Runner stopped before upload suite |
| Destructive cleanup | Not executed | No QA-owned records were created |
| Extraction job | Not executed | Disabled by input |
| Global-state map/settings rollback | Not executed | Disabled by input |

## Data Mutation And Cleanup

No QA-owned records were created during this run.

No destructive cleanup requests were executed.

No storage artifacts were created.

## Assessment

The development backend is reachable from GitHub Actions and core read-only endpoints are mostly operational. Authentication works for the author account, protected endpoints correctly reject missing tokens, and several primary read-only resources return `200`.

Full QA cannot be considered complete because the run stopped before mutation and destructive suites. The immediate blocker is the invalid or missing PL7 seed account expected by the QA guide and runner.

## Recommendations

1. Fix or confirm the PL7 test credential for development.
   - Current failing account: `exec7@morneven.com`.
   - Expected password source: `QA_SEED_PASSWORD` or default `SeedPassword123`.

2. Decide whether `/api/health` and `/api/ready` should exist.
   - If yes, mount health and readiness under `/api`.
   - If no, update `QA_RAILWAY_TEST_GUIDE.md` and the QA runner to only expect `/health` and `/ready`.

3. Patch the QA runner to continue after privileged login failure.
   - Non-privileged mutation suites can still run with the author account.
   - PL7-only suites should be marked `BLOCKED`, not crash the runner.

4. Re-run `Development API QA` after fixing the PL7 account or runner behavior.

