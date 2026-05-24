CREATE TABLE "SiteVisitEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "visitorKey" TEXT NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "hits" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SiteVisitEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteVisitEvent_visitorKey_bucketStart_key"
ON "SiteVisitEvent"("visitorKey", "bucketStart");

CREATE INDEX "SiteVisitEvent_userId_bucketStart_idx"
ON "SiteVisitEvent"("userId", "bucketStart");

CREATE INDEX "SiteVisitEvent_bucketStart_idx"
ON "SiteVisitEvent"("bucketStart");

ALTER TABLE "SiteVisitEvent"
ADD CONSTRAINT "SiteVisitEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SiteVisitEvent" ("id", "userId", "visitorKey", "bucketStart", "hits", "createdAt", "lastSeenAt")
SELECT
  md5(random()::text || clock_timestamp()::text || "id"),
  "userId",
  'session:' || "id",
  to_timestamp(floor(extract(epoch FROM "lastSeenAt") / 21600) * 21600) AT TIME ZONE 'UTC',
  1,
  "createdAt",
  "lastSeenAt"
FROM "SecuritySession";
