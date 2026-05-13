ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "statusExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_accountStatus_statusExpiresAt_idx" ON "User"("accountStatus", "statusExpiresAt");
