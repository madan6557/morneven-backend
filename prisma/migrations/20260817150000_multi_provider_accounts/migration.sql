-- Generalize the single-provider credential and OpenRouter-only profile
-- storage into named provider accounts. Legacy tables remain intact for
-- rollback and compatibility backups; runtime code reads the new table.
CREATE TABLE IF NOT EXISTS "BotManagerProviderAccount" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "keyPreview" TEXT,
  "modelId" TEXT NOT NULL,
  "apiBase" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "notes" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BotManagerProviderAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BotManagerIdentity"
  ADD COLUMN IF NOT EXISTS "runtimeProviderAccountId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BotManagerProviderAccount_provider_name_key"
  ON "BotManagerProviderAccount" ("provider", "name");
CREATE INDEX IF NOT EXISTS "BotManagerProviderAccount_provider_isActive_idx"
  ON "BotManagerProviderAccount" ("provider", "isActive");
CREATE INDEX IF NOT EXISTS "BotManagerProviderAccount_updatedAt_idx"
  ON "BotManagerProviderAccount" ("updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "BotManagerProviderAccount_one_active_per_provider_key"
  ON "BotManagerProviderAccount" ("provider")
  WHERE "isActive" = true;

-- Legacy OpenRouter did not enforce one active row at the database level.
-- Keep the most recently updated active profile before copying it.
WITH keep_active AS (
  SELECT "id"
  FROM "BotManagerOpenRouterProfile"
  WHERE "isActive" = true
  ORDER BY "updatedAt" DESC
  LIMIT 1
)
UPDATE "BotManagerOpenRouterProfile"
SET "isActive" = false
WHERE "isActive" = true
  AND "id" NOT IN (SELECT "id" FROM keep_active);

-- Existing credentials become the default account for their provider.
INSERT INTO "BotManagerProviderAccount" (
  "id", "provider", "name", "encryptedValue", "keyPreview", "modelId",
  "apiBase", "metadata", "isActive", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  c."id", c."provider",
  CASE
    WHEN c."provider" = 'openrouter'
      AND EXISTS (SELECT 1 FROM "BotManagerOpenRouterProfile" p WHERE p."name" = 'default')
      THEN 'default-legacy-' || LEFT(c."id", 8)
    ELSE 'default'
  END,
  c."encryptedValue", c."keyPreview",
  COALESCE(NULLIF(c."metadata"->>'modelId', ''), 'runtime-import'),
  NULLIF(c."metadata"->>'apiBase', ''), c."metadata",
  CASE
    WHEN c."provider" = 'openrouter'
      AND EXISTS (SELECT 1 FROM "BotManagerOpenRouterProfile" p WHERE p."isActive" = true)
      THEN false
    ELSE true
  END,
  c."updatedBy", c."createdAt", c."updatedAt"
FROM "BotManagerCredential" c
WHERE NOT EXISTS (
  SELECT 1 FROM "BotManagerProviderAccount" a WHERE a."id" = c."id"
);

-- OpenRouter profiles keep their IDs so existing identity references remain
-- valid when they are copied into the generic account table.
INSERT INTO "BotManagerProviderAccount" (
  "id", "provider", "name", "encryptedValue", "keyPreview", "modelId",
  "apiBase", "tags", "notes", "metadata", "isActive", "updatedBy",
  "createdAt", "updatedAt"
)
SELECT
  p."id", 'openrouter', p."name", p."encryptedValue", p."keyPreview",
  p."modelId", p."apiBase", p."tags", p."notes", '{}'::jsonb,
  p."isActive", p."updatedBy", p."createdAt", p."updatedAt"
FROM "BotManagerOpenRouterProfile" p
WHERE NOT EXISTS (
  SELECT 1 FROM "BotManagerProviderAccount" a WHERE a."id" = p."id"
);

UPDATE "BotManagerIdentity"
SET "runtimeProviderAccountId" = "runtimeOpenRouterProfileId"
WHERE "runtimeProviderAccountId" IS NULL
  AND "runtimeOpenRouterProfileId" IS NOT NULL;
