CREATE TYPE "ContentReactionKind" AS ENUM ('like', 'dislike', 'star');

CREATE TABLE "ContentMetric" (
  "id" TEXT NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" TEXT NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "likes" INTEGER NOT NULL DEFAULT 0,
  "dislikes" INTEGER NOT NULL DEFAULT 0,
  "stars" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContentMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContentReaction" (
  "id" TEXT NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" "ContentReactionKind" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContentReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentMetric_entityType_entityId_key" ON "ContentMetric"("entityType", "entityId");
CREATE INDEX "ContentMetric_entityType_views_idx" ON "ContentMetric"("entityType", "views");
CREATE INDEX "ContentMetric_entityType_likes_idx" ON "ContentMetric"("entityType", "likes");
CREATE INDEX "ContentMetric_entityType_dislikes_idx" ON "ContentMetric"("entityType", "dislikes");
CREATE INDEX "ContentMetric_entityType_stars_idx" ON "ContentMetric"("entityType", "stars");
CREATE UNIQUE INDEX "ContentReaction_entityType_entityId_userId_kind_key" ON "ContentReaction"("entityType", "entityId", "userId", "kind");
CREATE INDEX "ContentReaction_entityType_entityId_idx" ON "ContentReaction"("entityType", "entityId");
CREATE INDEX "ContentReaction_userId_idx" ON "ContentReaction"("userId");

ALTER TABLE "ContentReaction"
  ADD CONSTRAINT "ContentReaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ContentMetric" ("id", "entityType", "entityId", "views", "likes", "dislikes", "stars", "createdAt", "updatedAt")
SELECT 'metric-gallery-' || "id", 'gallery'::"EntityType", "id", 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "GalleryItem"
ON CONFLICT ("entityType", "entityId") DO NOTHING;

INSERT INTO "ContentMetric" ("id", "entityType", "entityId", "views", "likes", "dislikes", "stars", "createdAt", "updatedAt")
SELECT 'metric-' || "category"::TEXT || '-' || "id", "category", "id", 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "LoreItem"
ON CONFLICT ("entityType", "entityId") DO NOTHING;
