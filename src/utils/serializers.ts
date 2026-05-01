import { EntityType, MediaType, Prisma, ProjectStatus, Role } from '@prisma/client';

export const dateOnly = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

export const jsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> => {
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

  if (item.category === EntityType.other || item.category === EntityType.event) {
    return {
      ...common,
      title: item.name,
      category: item.type ?? String(metadata.category ?? '')
    };
  }

  if (item.category === EntityType.technology) {
    return {
      ...common,
      name: item.name,
      category: item.type ?? String(metadata.category ?? '')
    };
  }

  if (item.category === EntityType.creature) {
    return {
      ...common,
      name: item.name,
      classification: item.type ?? String(metadata.classification ?? '')
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
