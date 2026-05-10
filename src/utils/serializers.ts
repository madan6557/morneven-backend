import { EntityType, MediaType, Prisma, ProjectStatus, Role } from '@prisma/client';
import {
  asObject,
  normalizeCharacterStats,
  normalizeCreatureStats,
  normalizeFeatureItems,
  normalizeSkillItems
} from './lore-contract.js';
import { getPresenceSnapshot } from '../modules/presence/service.js';

const ROLE_ADMIN = 'admin' as Role;

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
  if (level >= 7) return ROLE_ADMIN;
  if (level <= 0) return Role.guest;
  return Role.personel;
};

export const normalizeUserRole = (role: Role, level: number): Role => {
  if (role === Role.author) return Role.author;
  if (level >= 7) return ROLE_ADMIN;
  if (level <= 0) return Role.guest;
  return role === Role.guest ? Role.guest : Role.personel;
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

export const serializeProject = (project: ProjectWithPatches) => {
  const meta = jsonObject(project.meta);
  return {
  id: project.id,
  title: project.title,
  status: projectStatusToApi(project.status),
  thumbnail: project.thumbnail ?? '',
  headerImage: typeof meta.headerImage === 'string' ? meta.headerImage : undefined,
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
  meta: project.meta ?? undefined,
  features: normalizeFeatureItems(meta.features)
  };
};

type SerializableUser = {
  id: string;
  username: string;
  email: string;
  role: Role;
  level: number;
  track: Prisma.UserGetPayload<object>['track'];
  note: string | null;
  updatedAt: Date | string;
};

export const serializeUser = (user: SerializableUser) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  role: normalizeUserRole(user.role, user.level),
  level: user.level,
  track: user.track,
  note: user.note ?? '',
  updatedAt: dateOnly(user.updatedAt),
  ...getPresenceSnapshot(user.username)
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
type DiscussionRecord = Prisma.CommentGetPayload<{ include: { author: true; replies: { include: { author: true } } } }>;

export const serializeDoc = (doc: EntityDocRecord) => ({
  type: doc.type === MediaType.video ? 'video' : doc.type === MediaType.file ? 'file' : 'image',
  url: doc.url,
  caption: doc.caption ?? ''
});

const extractTextMentions = (text: string) =>
  Array.from(text.matchAll(/@([\w.-]+)/g)).map((match) => ({
    username: match[1],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));

export const serializeDiscussionComments = (comments: DiscussionRecord[]) =>
  comments.map((comment) => ({
    id: comment.id,
    author: comment.author.username,
    text: comment.text,
    date: dateOnly(comment.createdAt),
    mentions: extractTextMentions(comment.text),
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      author: reply.author.username,
      text: reply.text,
      date: dateOnly(reply.createdAt),
      mentions: extractTextMentions(reply.text)
    }))
  }));

export const serializeLoreItem = (item: LoreRecord, docs: EntityDocRecord[] = [], discussions?: DiscussionRecord[]) => {
  const metadata = asObject(item.metadata);
  const common = {
    ...metadata,
    id: item.id,
    thumbnail: item.thumbnail ?? '',
    headerImage: typeof metadata.headerImage === 'string' ? metadata.headerImage : undefined,
    shortDesc: item.shortDesc,
    fullDesc: item.fullDesc,
    docs: docs.map(serializeDoc),
    ...(discussions ? { discussions: serializeDiscussionComments(discussions) } : {}),
    contributor: metadata.contributor,
    meta: metadata.meta
  };

  if (item.category === EntityType.creature) {
    return {
      ...common,
      name: item.name,
      classification: item.type ?? String(metadata.classification ?? ''),
      stats: normalizeCreatureStats(metadata.stats, metadata.dangerLevel),
      skills: normalizeSkillItems(metadata.skills)
    };
  }

  if (item.category === EntityType.character) {
    return {
      ...common,
      name: item.name,
      type: item.type ?? String(metadata.type ?? ''),
      stats: normalizeCharacterStats(metadata.stats),
      skills: normalizeSkillItems(metadata.skills)
    };
  }

  if (item.category === EntityType.event) {
    return {
      ...common,
      title: item.name,
      category: item.type ?? String(metadata.category ?? ''),
      features: normalizeFeatureItems(metadata.features)
    };
  }

  if (item.category === EntityType.place || item.category === EntityType.technology || item.category === EntityType.other) {
    return {
      ...common,
      ...(item.category === EntityType.other
        ? { title: item.name, category: item.type ?? String(metadata.category ?? '') }
        : { name: item.name, type: item.type ?? String(metadata.type ?? ''), category: item.type ?? String(metadata.category ?? '') }),
      features: normalizeFeatureItems(metadata.features)
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
