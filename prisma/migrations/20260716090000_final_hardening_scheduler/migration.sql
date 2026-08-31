ALTER TABLE "ExtractionJob"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "request" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "parentJobId" TEXT,
  ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);

ALTER TABLE "ExtractionJob" ALTER COLUMN "status" SET DEFAULT 'queued';

CREATE UNIQUE INDEX IF NOT EXISTS "ExtractionJob_createdBy_idempotencyKey_key"
  ON "ExtractionJob"("createdBy", "idempotencyKey");
UPDATE "ExtractionJob"
SET
  "status" = 'stopped',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "error" = COALESCE("error", 'Backup job stopped because it expired before completion.'),
  "leaseOwner" = NULL,
  "leaseUntil" = NULL
WHERE "status" IN ('queued', 'processing') AND "expiresAt" <= CURRENT_TIMESTAMP;

WITH ranked_active_jobs AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "createdBy"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "ExtractionJob"
  WHERE "status" IN ('queued', 'processing')
)
UPDATE "ExtractionJob"
SET
  "status" = 'stopped',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "error" = COALESCE("error", 'Duplicate active backup job stopped during scheduler migration.'),
  "leaseOwner" = NULL,
  "leaseUntil" = NULL
WHERE "id" IN (
  SELECT "id" FROM ranked_active_jobs WHERE row_number > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtractionJob_createdBy_active_key"
  ON "ExtractionJob"("createdBy")
  WHERE "status" IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS "ExtractionJob_status_leaseUntil_createdAt_idx"
  ON "ExtractionJob"("status", "leaseUntil", "createdAt");
CREATE INDEX IF NOT EXISTS "ExtractionJob_source_createdAt_idx"
  ON "ExtractionJob"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "ExtractionJob_createdBy_status_createdAt_idx"
  ON "ExtractionJob"("createdBy", "status", "createdAt");

CREATE TABLE IF NOT EXISTS "ScheduledTask" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "targetId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "timezone" TEXT NOT NULL,
  "schedule" JSONB NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastStatus" TEXT,
  "lastError" TEXT,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScheduledTaskRun" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'running',
  "result" JSONB,
  "error" TEXT,
  "workerId" TEXT,
  CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledTaskRun_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "RuntimeControlState" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "frozen" BOOLEAN NOT NULL DEFAULT false,
  "frozenAt" TIMESTAMP(3),
  "reason" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuntimeControlState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledTask_key_key" ON "ScheduledTask"("key");
CREATE INDEX IF NOT EXISTS "ScheduledTask_enabled_nextRunAt_idx" ON "ScheduledTask"("enabled", "nextRunAt");
CREATE INDEX IF NOT EXISTS "ScheduledTask_kind_targetId_idx" ON "ScheduledTask"("kind", "targetId");
CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledTaskRun_taskId_scheduledFor_key"
  ON "ScheduledTaskRun"("taskId", "scheduledFor");
CREATE INDEX IF NOT EXISTS "ScheduledTaskRun_status_startedAt_idx" ON "ScheduledTaskRun"("status", "startedAt");
