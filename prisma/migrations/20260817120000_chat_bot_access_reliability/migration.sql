-- Additive chat reliability and bot access migration.
-- Existing rows receive safe defaults: bot access disabled and bot policy disabled.
ALTER TABLE "ChatConversation"
  ADD COLUMN IF NOT EXISTS "botPolicy" JSONB NOT NULL DEFAULT '{"mode":"disabled","allowedIdentityIds":[],"allowBotToBot":false,"maxTurns":2,"maxTokensPerRun":1200}'::jsonb;

ALTER TABLE "ChatConversation"
  ADD COLUMN IF NOT EXISTS "lastServerSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "clientId" TEXT;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "senderType" TEXT NOT NULL DEFAULT 'user';

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "botIdentityId" TEXT;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT NOT NULL DEFAULT 'sent';

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "serverSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "BotManagerIdentity"
  ADD COLUMN IF NOT EXISTS "chatAccess" JSONB NOT NULL DEFAULT '{"mode":"disabled","allowBotToBot":false,"maxTurns":2,"maxTokensPerRun":1200}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_conversationId_clientId_key"
  ON "ChatMessage" ("conversationId", "clientId")
  WHERE "clientId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ChatConversation_updatedAt_idx"
  ON "ChatConversation" ("updatedAt");

CREATE INDEX IF NOT EXISTS "ChatMessage_conversationId_serverSequence_idx"
  ON "ChatMessage" ("conversationId", "serverSequence");

CREATE INDEX IF NOT EXISTS "ChatMessage_botIdentityId_idx"
  ON "ChatMessage" ("botIdentityId");