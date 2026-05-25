ALTER TABLE "BotManagerIdentity"
  ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "runtimeProvider" TEXT,
  ADD COLUMN "runtimeOpenRouterProfileId" TEXT;

UPDATE "BotManagerIdentity"
SET "isMain" = true
WHERE "id" = (
  SELECT "id"
  FROM "BotManagerIdentity"
  WHERE "isActive" = true
  ORDER BY "updatedAt" DESC
  LIMIT 1
);

CREATE INDEX "BotManagerIdentity_isMain_idx" ON "BotManagerIdentity"("isMain");
