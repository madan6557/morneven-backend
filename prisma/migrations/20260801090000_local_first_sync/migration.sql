CREATE TYPE "SyncEntity" AS ENUM ('project', 'lore', 'gallery');

CREATE TYPE "SyncAction" AS ENUM ('upsert', 'delete');

CREATE TABLE "SyncChange" (
    "sequence" BIGSERIAL NOT NULL,
    "operationId" TEXT NOT NULL,
    "clientId" TEXT,
    "entity" "SyncEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "SyncAction" NOT NULL,
    "record" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncChange_pkey" PRIMARY KEY ("sequence")
);

CREATE UNIQUE INDEX "SyncChange_operationId_key" ON "SyncChange"("operationId");
CREATE INDEX "SyncChange_entity_entityId_sequence_idx" ON "SyncChange"("entity", "entityId", "sequence");
CREATE INDEX "SyncChange_sequence_idx" ON "SyncChange"("sequence");
