ALTER TYPE "MediaType" ADD VALUE IF NOT EXISTS 'file';
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'event';

ALTER TABLE "CommandCenterSettings"
  ADD COLUMN IF NOT EXISTS "showCharacters" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showPlaces" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showTechnology" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showGallery" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showQuickActions" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CommandCenterSettings"
  ALTER COLUMN "welcomeMessage" SET DEFAULT 'Here''s your operational overview.',
  ALTER COLUMN "itemLimits" SET DEFAULT '{"projects":5,"news":6,"characters":3,"places":3,"technology":3,"gallery":4}'::jsonb,
  ALTER COLUMN "manualSelections" SET DEFAULT '{"projects":[],"news":[],"characters":[],"places":[],"technology":[],"gallery":[]}'::jsonb;

UPDATE "CommandCenterSettings"
SET
  "welcomeMessage" = COALESCE("welcomeMessage", 'Here''s your operational overview.'),
  "itemLimits" = COALESCE("itemLimits", '{"projects":5,"news":6,"characters":3,"places":3,"technology":3,"gallery":4}'::jsonb),
  "manualSelections" = COALESCE("manualSelections", '{"projects":[],"news":[],"characters":[],"places":[],"technology":[],"gallery":[]}'::jsonb);

ALTER TABLE "CommandCenterSettings"
  ALTER COLUMN "welcomeMessage" SET NOT NULL,
  ALTER COLUMN "itemLimits" SET NOT NULL,
  ALTER COLUMN "manualSelections" SET NOT NULL;

ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "docs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "contributor" TEXT,
  ADD COLUMN IF NOT EXISTS "meta" JSONB,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Project"
  ALTER COLUMN "thumbnail" SET DEFAULT '';

ALTER TABLE "LoreItem"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "GalleryItem"
  ALTER COLUMN "thumbnail" SET DEFAULT '';

CREATE TABLE IF NOT EXISTS "ManagementRequest" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "requester" TEXT NOT NULL,
  "requesterTrack" "Track" NOT NULL,
  "requesterLevel" INTEGER NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reviewer" TEXT,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "ManagementRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Team" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "leader" TEXT NOT NULL,
  "members" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "track" "Track" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cycleYear" INTEGER NOT NULL,
  "completed" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QuotaRecord" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "monthly" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "yearly" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "supervised" JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "QuotaRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "QuotaRecord_username_key" ON "QuotaRecord"("username");

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "recipient" TEXT NOT NULL,
  "sender" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "link" TEXT,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NotificationRead" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationRead_notificationId_username_key"
  ON "NotificationRead"("notificationId", "username");

ALTER TABLE "NotificationRead"
  ADD CONSTRAINT "NotificationRead_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatConversation" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "source" JSONB,
  "systemManaged" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChatConversationMember" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "status" TEXT NOT NULL DEFAULT 'active',
  "invitedBy" TEXT,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatConversationMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatConversationMember_conversationId_username_key"
  ON "ChatConversationMember"("conversationId", "username");

ALTER TABLE "ChatConversationMember"
  ADD CONSTRAINT "ChatConversationMember_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "text" TEXT NOT NULL DEFAULT '',
  "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "system" BOOLEAN NOT NULL DEFAULT false,
  "replyTo" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ChatReadState" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatReadState_conversationId_username_key"
  ON "ChatReadState"("conversationId", "username");

ALTER TABLE "ChatReadState"
  ADD CONSTRAINT "ChatReadState_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ExtractionJob" (
  "id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "autoDownload" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "downloadName" TEXT,
  "artifactPath" TEXT,
  "artifactUrl" TEXT,
  "error" TEXT,
  "progress" JSONB NOT NULL DEFAULT '{"percent":0,"stage":"queued","message":"Queued"}'::jsonb,
  CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT NOT NULL,
  "actor" TEXT,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
