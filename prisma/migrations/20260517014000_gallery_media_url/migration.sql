ALTER TABLE "GalleryItem" ADD COLUMN "mediaUrl" TEXT;

UPDATE "GalleryItem"
SET "mediaUrl" = "videoUrl"
WHERE "type" = 'image'
  AND "mediaUrl" IS NULL
  AND "videoUrl" IS NOT NULL
  AND "videoUrl" <> '';
