ALTER TABLE "CommandCenterSettings"
ADD COLUMN "presetKey" TEXT,
ADD COLUMN "presetName" TEXT NOT NULL DEFAULT 'System Preset',
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "CommandCenterSettings"
SET
  "presetKey" = CASE
    WHEN "id" = 'main' THEN 'default'
    ELSE 'preset-' || REPLACE("id", '-', '')
  END,
  "isActive" = CASE WHEN "id" = 'main' THEN true ELSE false END,
  "presetName" = CASE WHEN "id" = 'main' THEN 'Default System Preset' ELSE 'System Preset' END;

ALTER TABLE "CommandCenterSettings"
ALTER COLUMN "presetKey" SET NOT NULL;

CREATE UNIQUE INDEX "CommandCenterSettings_presetKey_key" ON "CommandCenterSettings"("presetKey");
