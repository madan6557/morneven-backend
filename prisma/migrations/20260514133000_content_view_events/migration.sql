CREATE TABLE "ContentViewEvent" (
  "id" TEXT NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" TEXT NOT NULL,
  "viewerKey" TEXT NOT NULL,
  "viewerKind" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentViewEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentViewEvent_entityType_entityId_viewerKey_bucketStart_key"
ON "ContentViewEvent"("entityType", "entityId", "viewerKey", "bucketStart");

CREATE INDEX "ContentViewEvent_entityType_entityId_createdAt_idx"
ON "ContentViewEvent"("entityType", "entityId", "createdAt");

CREATE INDEX "ContentViewEvent_viewerKey_createdAt_idx"
ON "ContentViewEvent"("viewerKey", "createdAt");
