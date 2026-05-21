CREATE TABLE "BotManagerCredential" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "keyPreview" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotManagerGeneralConfig" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "config" JSONB NOT NULL DEFAULT '{}',
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerGeneralConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotManagerIdentity" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "roleTitle" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "profileImageObjectPath" TEXT,
  "profileImageUrl" TEXT,
  "channels" JSONB NOT NULL DEFAULT '{}',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BotManagerIdentityFile" (
  "id" TEXT NOT NULL,
  "identityId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "contentType" TEXT NOT NULL DEFAULT 'text/markdown',
  "objectPath" TEXT NOT NULL,
  "size" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerIdentityFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotManagerCredential_provider_key" ON "BotManagerCredential"("provider");
CREATE UNIQUE INDEX "BotManagerIdentity_slug_key" ON "BotManagerIdentity"("slug");
CREATE UNIQUE INDEX "BotManagerIdentity_single_active_key" ON "BotManagerIdentity"("isActive") WHERE "isActive" = true;
CREATE INDEX "BotManagerIdentity_isActive_idx" ON "BotManagerIdentity"("isActive");
CREATE INDEX "BotManagerIdentityFile_objectPath_idx" ON "BotManagerIdentityFile"("objectPath");
CREATE UNIQUE INDEX "BotManagerIdentityFile_identityId_path_key" ON "BotManagerIdentityFile"("identityId", "path");

ALTER TABLE "BotManagerIdentityFile"
  ADD CONSTRAINT "BotManagerIdentityFile_identityId_fkey"
  FOREIGN KEY ("identityId") REFERENCES "BotManagerIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
