# Development API QA

This folder contains the QA runner used by GitHub Actions and local execution.

## GitHub Actions

Workflow file:

```txt
.github/workflows/dev-api-qa.yml
```

The workflow is manual and should be run from the `development` branch.

Default target:

```txt
https://backend.dev.morneven.com
```

Default mode:

```txt
scope: full
allow_destructive_cleanup: true
include_global_state: false
include_file_upload: true
include_extraction: false
```

The default full mode creates QA-owned records, updates them, and deletes them where cleanup endpoints exist. Global-state tests and extraction jobs are disabled by default because they have broader side effects.

## Optional GitHub Secrets And Variables

The workflow can run with documented seed defaults. For stricter configuration, define these in GitHub:

Secrets:

```txt
QA_SEED_PASSWORD
```

Repository variables:

```txt
QA_AUTHOR_EMAIL
QA_GUEST_EMAIL
QA_EXEC7_EMAIL
QA_EXEC6_EMAIL
QA_FIELD5_EMAIL
```

By default, `QA_EXEC7_EMAIL` falls back to `author@morneven.com` because the current development seed has verified author login. Override it if development has a separate PL7 account.

## Local Run

Smoke test:

```bash
npm run qa:dev-api -- --scope smoke
```

Full QA with destructive cleanup for QA-owned records:

```bash
npm run qa:dev-api -- --scope full --allow-destructive --include-file-upload
```

Full QA with global-state rollback tests:

```bash
npm run qa:dev-api -- --scope full --allow-destructive --include-file-upload --include-global-state
```

Extraction job test:

```bash
npm run qa:dev-api -- --scope full --allow-destructive --include-extraction
```

Reports are written to:

```txt
qa/reports/
```
