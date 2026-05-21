CREATE TABLE IF NOT EXISTS "BotManagerOpenRouterProfile" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "keyPreview" TEXT,
  "modelId" TEXT NOT NULL,
  "apiBase" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "notes" TEXT NOT NULL DEFAULT '',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerOpenRouterProfile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BotManagerOpenRouterProfile_isActive_idx" ON "BotManagerOpenRouterProfile"("isActive");
CREATE INDEX IF NOT EXISTS "BotManagerOpenRouterProfile_updatedAt_idx" ON "BotManagerOpenRouterProfile"("updatedAt");

CREATE TABLE IF NOT EXISTS "BotManagerBackupJob" (
  "id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "identityIds" JSONB NOT NULL DEFAULT '[]',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "downloadName" TEXT,
  "artifactPath" TEXT,
  "artifactUrl" TEXT,
  "error" TEXT,
  "progress" JSONB NOT NULL DEFAULT '{"percent":0,"stage":"queued","message":"Queued"}',
  CONSTRAINT "BotManagerBackupJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BotManagerBackupJob_createdBy_createdAt_idx" ON "BotManagerBackupJob"("createdBy", "createdAt");
CREATE INDEX IF NOT EXISTS "BotManagerBackupJob_status_idx" ON "BotManagerBackupJob"("status");
