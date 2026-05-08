import { EntityType, Prisma } from '@prisma/client';

const CHARACTER_COMBAT_KEYS = ['strength', 'defense', 'agility', 'endurance', 'adaptation'] as const;
const CHARACTER_INTELLIGENCE_KEYS = ['iq', 'eq', 'sq'] as const;
const CHARACTER_CHARISMA_KEYS = ['persuasion', 'intimidation', 'manipulation'] as const;
const CHARACTER_STEALTH_KEYS = ['presenceControl', 'silence', 'environmentControl', 'visualMasking'] as const;
const CHARACTER_PERCEPTION_KEYS = ['acuity', 'focus', 'intuition'] as const;

const CREATURE_COMBAT_KEYS = ['strength', 'defense', 'agility', 'endurance', 'adaptation'] as const;
const CREATURE_COGNITION_KEYS = ['problemSolving', 'memory', 'instinct'] as const;
const CREATURE_PREDATION_KEYS = ['ambush', 'camouflage', 'quietude', 'trapping'] as const;
const CREATURE_SENSES_KEYS = ['tracking', 'detection', 'awareness'] as const;
const CREATURE_FEROCITY_KEYS = ['intimidation', 'dominance', 'hostility'] as const;

type JsonRecord = Record<string, unknown>;

const DANGER_LEVEL_BASELINE: Record<number, number> = {
  1: 28,
  2: 42,
  3: 58,
  4: 74,
  5: 90
};

export const asObject = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const clampStat = (value: unknown, fallback = 0) => {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
};

const average = (values: number[]) => {
  if (!values.length) return 0;
  return clampStat(values.reduce((sum, value) => sum + value, 0) / values.length);
};

const text = (value: unknown) => String(value ?? '').trim();

const textOrUndefined = (value: unknown) => {
  const normalized = text(value);
  return normalized ? normalized : undefined;
};

const stringArray = (value: unknown) => asArray(value).map((item) => text(item)).filter(Boolean);

const normalizeMetricGroup = <TKey extends string>(
  raw: unknown,
  keys: readonly TKey[],
  fallbackValue: number
) => {
  const source = asObject(raw);
  const providedValues = keys
    .map((key) => {
      if (source[key] === undefined || source[key] === null || source[key] === '') return null;
      return clampStat(source[key]);
    })
    .filter((value): value is number => value !== null);

  const fillValue = providedValues.length ? average(providedValues) : fallbackValue;

  return Object.fromEntries(keys.map((key) => [key, clampStat(source[key], fillValue)])) as Record<TKey, number>;
};

export const normalizeCharacterStats = (raw: unknown) => {
  const source = asObject(raw);
  const detail = asObject(source.detail);

  const combatDetail = normalizeMetricGroup(detail.combat, CHARACTER_COMBAT_KEYS, clampStat(source.combat, 50));
  const intelligenceDetail = normalizeMetricGroup(
    detail.intelligence,
    CHARACTER_INTELLIGENCE_KEYS,
    clampStat(source.intelligence, 50)
  );
  const charismaDetail = normalizeMetricGroup(detail.charisma, CHARACTER_CHARISMA_KEYS, clampStat(source.charisma, 50));
  const stealthDetail = normalizeMetricGroup(detail.stealth, CHARACTER_STEALTH_KEYS, clampStat(source.stealth, 50));
  const perceptionDetail = normalizeMetricGroup(
    detail.perception,
    CHARACTER_PERCEPTION_KEYS,
    clampStat(source.perception ?? source.endurance, 50)
  );

  return {
    combat: average(Object.values(combatDetail)),
    intelligence: average(Object.values(intelligenceDetail)),
    charisma: average(Object.values(charismaDetail)),
    stealth: average(Object.values(stealthDetail)),
    perception: average(Object.values(perceptionDetail)),
    detail: {
      combat: combatDetail,
      intelligence: intelligenceDetail,
      charisma: charismaDetail,
      stealth: stealthDetail,
      perception: perceptionDetail
    }
  };
};

export const normalizeCreatureStats = (raw: unknown, dangerLevel?: unknown) => {
  const source = asObject(raw);
  const detail = asObject(source.detail);
  const baseline = DANGER_LEVEL_BASELINE[Number(dangerLevel)] ?? 50;

  const combatDetail = normalizeMetricGroup(detail.combat, CREATURE_COMBAT_KEYS, clampStat(source.combat, baseline));
  const cognitionDetail = normalizeMetricGroup(
    detail.cognition,
    CREATURE_COGNITION_KEYS,
    clampStat(source.cognition ?? source.intelligence, baseline)
  );
  const predationDetail = normalizeMetricGroup(
    detail.predation,
    CREATURE_PREDATION_KEYS,
    clampStat(source.predation ?? source.stealth, baseline)
  );
  const sensesDetail = normalizeMetricGroup(
    detail.senses,
    CREATURE_SENSES_KEYS,
    clampStat(source.senses ?? source.endurance, baseline)
  );
  const ferocityDetail = normalizeMetricGroup(detail.ferocity, CREATURE_FEROCITY_KEYS, clampStat(source.ferocity, baseline));

  return {
    combat: average(Object.values(combatDetail)),
    cognition: average(Object.values(cognitionDetail)),
    predation: average(Object.values(predationDetail)),
    senses: average(Object.values(sensesDetail)),
    ferocity: average(Object.values(ferocityDetail)),
    detail: {
      combat: combatDetail,
      cognition: cognitionDetail,
      predation: predationDetail,
      senses: sensesDetail,
      ferocity: ferocityDetail
    }
  };
};

export const normalizeSkillItems = (value: unknown) =>
  asArray(value).map((entry, index) => {
    const raw = asObject(entry);
    const cooldown = text(raw.cooldown ?? raw.cd ?? raw.recovery) || text(raw.level);
    const baseDescription = text(raw.description ?? raw.details ?? raw.summary);
    const description =
      raw.immune === true && !baseDescription.includes('[[attr:immune')
        ? `${baseDescription} ${baseDescription ? '' : ''}[[attr:immune]]`.trim()
        : baseDescription;
    return {
      id: text(raw.id) || `skill-${index + 1}`,
      name: text(raw.name ?? raw.title) || `Skill ${index + 1}`,
      category: text(raw.category) || 'general',
      cooldown,
      description,
      ...(textOrUndefined(raw.icon) ? { icon: text(raw.icon) } : {}),
      ...(textOrUndefined(raw.color ?? raw.accentColor) ? { color: text(raw.color ?? raw.accentColor) } : {})
    };
  });

export const normalizeFeatureItems = (value: unknown) =>
  asArray(value).map((entry, index) => {
    const raw = asObject(entry);
    return {
      id: text(raw.id) || `feature-${index + 1}`,
      title: text(raw.title ?? raw.name) || `Feature ${index + 1}`,
      summary: text(raw.summary ?? raw.tagline ?? raw.description),
      ...(textOrUndefined(raw.details) ? { details: text(raw.details) } : {}),
      ...(textOrUndefined(raw.icon) ? { icon: text(raw.icon) } : {}),
      ...(textOrUndefined(raw.color ?? raw.accentColor) ? { color: text(raw.color ?? raw.accentColor) } : {}),
      ...(stringArray(raw.tags).length ? { tags: stringArray(raw.tags) } : {})
    };
  });

const stripTopLevelLoreFields = (input: JsonRecord) => ({
  ...input,
  docs: undefined,
  discussions: undefined,
  name: undefined,
  title: undefined,
  type: undefined,
  category: undefined,
  classification: undefined,
  thumbnail: undefined,
  shortDesc: undefined,
  fullDesc: undefined
});

export const normalizeLoreMetadata = (
  entityType: EntityType,
  body: JsonRecord,
  existingMetadata?: Prisma.JsonValue | null
) => {
  const merged = {
    ...stripTopLevelLoreFields(asObject(existingMetadata)),
    ...stripTopLevelLoreFields(body)
  } as JsonRecord;

  if (entityType === EntityType.character) {
    merged.stats = normalizeCharacterStats(body.stats ?? asObject(existingMetadata).stats);
    merged.skills = normalizeSkillItems(body.skills ?? asObject(existingMetadata).skills);
  }

  if (entityType === EntityType.creature) {
    const nextDangerLevel = body.dangerLevel ?? asObject(existingMetadata).dangerLevel;
    merged.stats = normalizeCreatureStats(body.stats ?? asObject(existingMetadata).stats, nextDangerLevel);
    merged.skills = normalizeSkillItems(body.skills ?? asObject(existingMetadata).skills);
  }

  if (
    entityType === EntityType.place ||
    entityType === EntityType.technology ||
    entityType === EntityType.other ||
    entityType === EntityType.event
  ) {
    merged.features = normalizeFeatureItems(body.features ?? asObject(existingMetadata).features);
  }

  return merged;
};

export const normalizeProjectMeta = (
  meta: unknown,
  features: unknown,
  headerImage?: unknown,
  existingMeta?: Prisma.JsonValue | null
) => {
  const merged = {
    ...asObject(existingMeta),
    ...asObject(meta)
  } as JsonRecord;

  if (headerImage !== undefined) {
    merged.headerImage = text(headerImage);
  }

  if (meta !== undefined || features !== undefined) {
    merged.features = normalizeFeatureItems(features ?? merged.features);
  }

  return merged;
};
