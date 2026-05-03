-- Convert CommandCenterSettings from per-user rows to a single global row.
-- Keep one canonical snapshot and migrate it to id = 'main'.

CREATE TABLE "CommandCenterSettings_new" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "showStats" BOOLEAN NOT NULL DEFAULT true,
    "showProjects" BOOLEAN NOT NULL DEFAULT true,
    "showNews" BOOLEAN NOT NULL DEFAULT true,
    "showCharacters" BOOLEAN NOT NULL DEFAULT true,
    "showPlaces" BOOLEAN NOT NULL DEFAULT true,
    "showTechnology" BOOLEAN NOT NULL DEFAULT true,
    "showGallery" BOOLEAN NOT NULL DEFAULT true,
    "showQuickActions" BOOLEAN NOT NULL DEFAULT true,
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Here''s your operational overview.',
    "itemLimits" JSONB NOT NULL DEFAULT '{"projects":5,"news":6,"characters":3,"places":3,"technology":3,"gallery":4}',
    "manualSelections" JSONB NOT NULL DEFAULT '{"projects":[],"news":[],"characters":[],"places":[],"technology":[],"gallery":[]}',
    "updatedBy" TEXT,
    CONSTRAINT "CommandCenterSettings_new_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CommandCenterSettings_new" (
    "id",
    "showStats",
    "showProjects",
    "showNews",
    "showCharacters",
    "showPlaces",
    "showTechnology",
    "showGallery",
    "showQuickActions",
    "welcomeMessage",
    "itemLimits",
    "manualSelections"
)
SELECT
    'main',
    "showStats",
    "showProjects",
    "showNews",
    "showCharacters",
    "showPlaces",
    "showTechnology",
    "showGallery",
    "showQuickActions",
    "welcomeMessage",
    "itemLimits",
    "manualSelections"
FROM "CommandCenterSettings"
ORDER BY "userId" ASC
LIMIT 1
ON CONFLICT ("id") DO NOTHING;

DROP TABLE "CommandCenterSettings";

ALTER TABLE "CommandCenterSettings_new" RENAME TO "CommandCenterSettings";
