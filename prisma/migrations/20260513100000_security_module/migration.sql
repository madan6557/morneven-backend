ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'security';

ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE TABLE IF NOT EXISTS "SecuritySession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecuritySession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id" TEXT NOT NULL,
  "requestId" TEXT,
  "actorId" TEXT,
  "actorUsername" TEXT,
  "sessionId" TEXT,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT,
  "resourceId" TEXT,
  "severity" TEXT NOT NULL,
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "decision" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SecurityBlock" (
  "id" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectHash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  CONSTRAINT "SecurityBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SecurityPolicy" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL DEFAULT '{}',
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SecurityPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FileScanRecord" (
  "id" TEXT NOT NULL,
  "objectPath" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "verdict" TEXT NOT NULL,
  "provider" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileScanRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
CREATE INDEX IF NOT EXISTS "SecuritySession_userId_revokedAt_idx" ON "SecuritySession"("userId", "revokedAt");
CREATE INDEX IF NOT EXISTS "SecuritySession_lastSeenAt_idx" ON "SecuritySession"("lastSeenAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_severity_createdAt_idx" ON "SecurityEvent"("severity", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_action_createdAt_idx" ON "SecurityEvent"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_actorUsername_createdAt_idx" ON "SecurityEvent"("actorUsername", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityBlock_subjectType_subjectHash_expiresAt_idx" ON "SecurityBlock"("subjectType", "subjectHash", "expiresAt");
CREATE INDEX IF NOT EXISTS "SecurityBlock_revokedAt_expiresAt_idx" ON "SecurityBlock"("revokedAt", "expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityPolicy_key_key" ON "SecurityPolicy"("key");
CREATE INDEX IF NOT EXISTS "FileScanRecord_sha256_idx" ON "FileScanRecord"("sha256");
CREATE INDEX IF NOT EXISTS "FileScanRecord_verdict_createdAt_idx" ON "FileScanRecord"("verdict", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SecuritySession_userId_fkey'
  ) THEN
    ALTER TABLE "SecuritySession"
      ADD CONSTRAINT "SecuritySession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RefreshToken_sessionId_fkey'
  ) THEN
    ALTER TABLE "RefreshToken"
      ADD CONSTRAINT "RefreshToken_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "SecuritySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
