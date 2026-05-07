-- Enforce FE contract defaults for lore metadata sections and primary stat aliases.

-- Character: ensure perception exists (fallback from endurance) and skills array default.
UPDATE "LoreItem"
SET "metadata" = jsonb_set(
    jsonb_set(
      COALESCE("metadata", '{}'::jsonb),
      '{stats,perception}',
      to_jsonb(COALESCE(("metadata"->'stats'->>'perception')::int, ("metadata"->'stats'->>'endurance')::int, 0)),
      true
    ),
    '{skills}',
    COALESCE("metadata"->'skills', '[]'::jsonb),
    true
  )
WHERE "category" = 'character';

-- Creature: ensure cognition/predation/senses aliases exist and skills array default.
UPDATE "LoreItem"
SET "metadata" = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE("metadata", '{}'::jsonb), '{stats,cognition}', to_jsonb(COALESCE(("metadata"->'stats'->>'cognition')::int, ("metadata"->'stats'->>'intelligence')::int, 0)), true),
        '{stats,predation}', to_jsonb(COALESCE(("metadata"->'stats'->>'predation')::int, ("metadata"->'stats'->>'stealth')::int, 0)), true
      ),
      '{stats,senses}', to_jsonb(COALESCE(("metadata"->'stats'->>'senses')::int, ("metadata"->'stats'->>'endurance')::int, 0)), true
    ),
    '{skills}',
    COALESCE("metadata"->'skills', '[]'::jsonb),
    true
  )
WHERE "category" = 'creature';

-- Non-living entities consumed by FE feature section.
UPDATE "LoreItem"
SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{features}', COALESCE("metadata"->'features', '[]'::jsonb), true)
WHERE "category" IN ('place', 'technology', 'other');

-- Project entity uses `meta.features` instead of lore metadata.
UPDATE "Project"
SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{features}', COALESCE("meta"->'features', '[]'::jsonb), true);
