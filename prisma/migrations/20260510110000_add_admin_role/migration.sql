ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'admin';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'level'
  ) THEN
    EXECUTE '
      UPDATE "User"
      SET "role" = ''admin''::"Role"
      WHERE "level" >= 7
        AND "role"::text = ''personel''
    ';
  END IF;
END
$$;
