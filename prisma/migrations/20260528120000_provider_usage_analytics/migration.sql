CREATE TABLE "BotManagerProviderAnalyticsCredential" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "keyPreview" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BotManagerProviderAnalyticsCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotManagerProviderAnalyticsCredential_provider_key" ON "BotManagerProviderAnalyticsCredential"("provider");

CREATE TABLE "BotManagerProviderUsageEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "runtimeId" TEXT,
  "runtimeName" TEXT,
  "modelId" TEXT,
  "sessionKey" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedTokens" INTEGER NOT NULL DEFAULT 0,
  "requestCount" INTEGER NOT NULL DEFAULT 1,
  "stopReason" TEXT,
  "error" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BotManagerProviderUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotManagerProviderUsageEvent_eventId_key" ON "BotManagerProviderUsageEvent"("eventId");
CREATE INDEX "BotManagerProviderUsageEvent_provider_recordedAt_idx" ON "BotManagerProviderUsageEvent"("provider", "recordedAt");
CREATE INDEX "BotManagerProviderUsageEvent_runtimeId_recordedAt_idx" ON "BotManagerProviderUsageEvent"("runtimeId", "recordedAt");
