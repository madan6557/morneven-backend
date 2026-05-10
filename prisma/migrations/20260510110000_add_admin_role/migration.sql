ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'admin';

UPDATE "User"
SET "role" = 'admin'
WHERE "level" >= 7
  AND "role" = 'personel';
