import { EntityType, MediaType, Prisma, ProjectStatus, Role } from '@prisma/client';

export const dateOnly = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

export const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const jsonArray = <T>(value: Prisma.JsonValue | null | undefined): T[] => {
  if (!Array.isArray(value)) return [];
  return value as T[];
};

export const roleForLevel = (level: number): Role => {
  if (level >= 7) return Role.author;
  if (level <= 0) return Role.guest;
  return Role.personel;
};

export const projectStatusToApi = (status: ProjectStatus) => {
  if (status === ProjectStatus.OnProgress) return 'On Progress';
  if (status === ProjectStatus.OnHold) return 'On Hold';
  return status;
};

export const projectStatusFromApi = (status: unknown): ProjectStatus => {
  if (status === 'Planning') return ProjectStatus.Planning;
  if (status === 'On Progress' || status === 'OnProgress') return ProjectStatus.OnProgress;
  if (status === 'On Hold' || status === 'OnHold') return ProjectStatus.OnHold;
  if (status === 'Completed') return ProjectStatus.Completed;
  if (status === 'Canceled') return ProjectStatus.Canceled;
  return ProjectStatus.Planning;
};

type ProjectWithPatches = Prisma.ProjectGetPayload<{ include: { patches: true } }>;

export const serializeProject = (project: ProjectWithPatches) => ({
  id: project.id,
  title: project.title,
  status: projectStatusToApi(project.status),
  thumbnail: project.thumbnail ?? '',
  shortDesc: project.shortDesc,
  fullDesc: project.fullDesc,
  patches: project.patches
    .map((patch) => ({
      version: patch.version,
      date: dateOnly(patch.patchDate),
      notes: patch.notes
    }))
    .sort((a, b) => b.date.localeCompare(a.date)),
  docs: jsonArray(project.docs),
  archived: project.archived,
  contributor: project.contributor ?? undefined,
  meta: project.meta ?? undefined
});

type UserPublic = Prisma.UserGetPayload<object>;

export const serializeUser = (user: UserPublic) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  role: user.role,
  level: user.level,
  track: user.track,
  note: user.note ?? '',
  updatedAt: dateOnly(user.updatedAt)
});

type GalleryWithTags = Prisma.GalleryItemGetPayload<{ include: { tags: true; uploader: true } }>;

export const serializeGalleryItem = (item: GalleryWithTags, comments: unknown[] = []) => ({
  id: item.id,
  type: item.type === MediaType.video ? 'video' : 'image',
  title: item.title,
  thumbnail: item.thumbnail ?? '',
  videoUrl: item.videoUrl ?? undefined,
  caption: item.caption,
  tags: item.tags.map((tag) => tag.tag),
  date: dateOnly(item.uploadDate),
  uploadedBy: item.uploader?.username ?? item.uploadedBy,
  comments
});

type EntityDocRecord = Prisma.EntityDocGetPayload<object>;
type LoreRecord = Prisma.LoreItemGetPayload<object>;

export const serializeDoc = (doc: EntityDocRecord) => ({
  type: doc.type === MediaType.video ? 'video' : doc.type === MediaType.file ? 'file' : 'image',
  url: doc.url,
  caption: doc.caption ?? ''
});

export const serializeLoreItem = (item: LoreRecord, docs: EntityDocRecord[] = []) => {
  const metadata = jsonObject(item.metadata);
  const toInt = (value: unknown) => {
    const num = Number(value);
    if (Number.isNaN(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  };
  const average = (values: unknown[]) => {
    if (!values.length) return 0;
    return toInt(values.reduce<number>((sum, val) => sum + Number(val || 0), 0) / values.length);
  };
  const ensureSkills = (value: unknown) => (Array.isArray(value) ? value : []);
  const ensureFeatures = (value: unknown) => (Array.isArray(value) ? value : []);

  const normalizeCharacterStats = (raw: Record<string, unknown>) => {
    const detail = jsonObject(raw.detail);
    const combat = jsonObject(detail.combat);
    const intelligence = jsonObject(detail.intelligence);
    const charisma = jsonObject(detail.charisma);
    const stealth = jsonObject(detail.stealth);
    const perception = jsonObject(detail.perception);
    return {
      ...raw,
      combat: Object.keys(combat).length ? average(Object.values(combat)) : toInt(raw.combat),
      intelligence: Object.keys(intelligence).length ? average(Object.values(intelligence)) : toInt(raw.intelligence),
      charisma: Object.keys(charisma).length ? average(Object.values(charisma)) : toInt(raw.charisma),
      stealth: Object.keys(stealth).length ? average(Object.values(stealth)) : toInt(raw.stealth),
      perception: Object.keys(perception).length
        ? average(Object.values(perception))
        : toInt(raw.perception ?? raw.endurance),
      ...(raw.endurance !== undefined ? { endurance: toInt(raw.endurance) } : {})
    };
  };

  const normalizeCreatureStats = (raw: Record<string, unknown>) => {
    const detail = jsonObject(raw.detail);
    const combat = jsonObject(detail.combat);
    const cognition = jsonObject(detail.cognition);
    const predation = jsonObject(detail.predation);
    const senses = jsonObject(detail.senses);
    const ferocity = jsonObject(detail.ferocity);
    const legacyIntelligence = toInt(raw.intelligence);
    const legacyStealth = toInt(raw.stealth);
    const legacyEndurance = toInt(raw.endurance);
    return {
      ...raw,
      combat: Object.keys(combat).length ? average(Object.values(combat)) : toInt(raw.combat),
      cognition: Object.keys(cognition).length ? average(Object.values(cognition)) : toInt(raw.cognition ?? legacyIntelligence),
      predation: Object.keys(predation).length ? average(Object.values(predation)) : toInt(raw.predation ?? legacyStealth),
      senses: Object.keys(senses).length ? average(Object.values(senses)) : toInt(raw.senses ?? legacyEndurance),
      ferocity: Object.keys(ferocity).length ? average(Object.values(ferocity)) : toInt(raw.ferocity),
      ...(raw.intelligence !== undefined ? { intelligence: legacyIntelligence } : {}),
      ...(raw.stealth !== undefined ? { stealth: legacyStealth } : {}),
      ...(raw.endurance !== undefined ? { endurance: legacyEndurance } : {})
    };
  };
  const common = {
    ...metadata,
    id: item.id,
    thumbnail: item.thumbnail ?? '',
    shortDesc: item.shortDesc,
    fullDesc: item.fullDesc,
    docs: docs.map(serializeDoc),
    contributor: metadata.contributor,
    meta: metadata.meta
  };

  if (item.category === EntityType.creature) {
    return {
      ...common,
      name: item.name,
      classification: item.type ?? String(metadata.classification ?? ''),
      stats: normalizeCreatureStats(jsonObject(metadata.stats)),
      skills: ensureSkills(metadata.skills)
    };
  }

  if (item.category === EntityType.character) {
    return {
      ...common,
      name: item.name,
      type: item.type ?? String(metadata.type ?? ''),
      stats: normalizeCharacterStats(jsonObject(metadata.stats)),
      skills: ensureSkills(metadata.skills)
    };
  }

  if (item.category === EntityType.event) {
    return {
      ...common,
      title: item.name,
      category: item.type ?? String(metadata.category ?? '')
    };
  }

  if (item.category === EntityType.place || item.category === EntityType.technology || item.category === EntityType.other) {
    return {
      ...common,
      ...(item.category === EntityType.other
        ? { title: item.name, category: item.type ?? String(metadata.category ?? '') }
        : { name: item.name, type: item.type ?? String(metadata.type ?? ''), category: item.type ?? String(metadata.category ?? '') }),
      features: ensureFeatures(metadata.features)
    };
  }

  return {
    ...common,
    name: item.name,
    type: item.type ?? String(metadata.type ?? '')
  };
};

export const categoryToEntityType = (category: string): EntityType | null => {
  if (category === 'characters') return EntityType.character;
  if (category === 'places') return EntityType.place;
  if (category === 'technology') return EntityType.technology;
  if (category === 'creatures') return EntityType.creature;
  if (category === 'events') return EntityType.event;
  if (category === 'other' || category === 'others') return EntityType.other;
  return null;
};

export const entityTypeToCategory = (entityType: EntityType) => {
  if (entityType === EntityType.character) return 'characters';
  if (entityType === EntityType.place) return 'places';
  if (entityType === EntityType.technology) return 'technology';
  if (entityType === EntityType.creature) return 'creatures';
  if (entityType === EntityType.event) return 'events';
  if (entityType === EntityType.other) return 'other';
  return entityType;
};
