import { AccountStatus, EntityType, MediaType, Prisma, ProjectStatus, Role } from '@prisma/client';
import {
  asObject,
  normalizeCharacterStats,
  normalizeCreatureStats,
  normalizeFeatureItems,
  normalizeSkillItems
} from './lore-contract.js';
import { getPresenceSnapshot } from '../modules/presence/service.js';
import { emptyMetric, type ContentMetricSummary, type ViewerEngagement } from './content-metrics.js';

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
  if (role === ('security' as Role)) return role;
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
type ProjectDocJson = { type?: string; url?: string; thumbnail?: string; caption?: string; date?: string };

const docDateValue = (value?: string | null) => {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const sortDocsByDateDesc = <T extends { date?: string | null }>(docs: T[]) =>
  [...docs].sort((a, b) => docDateValue(b.date) - docDateValue(a.date));

const serializeProjectDoc = (doc: ProjectDocJson) => ({
  type: doc.type === 'video' ? 'video' : doc.type === 'file' ? 'file' : 'image',
  url: doc.url ?? '',
  thumbnail: doc.thumbnail ?? '',
  caption: doc.caption ?? '',
  ...(doc.date ? { date: doc.date } : {})
});

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
  docs: sortDocsByDateDesc(jsonArray<ProjectDocJson>(project.docs).map(serializeProjectDoc)),
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
  accountStatus: AccountStatus;
  level: number;
  track: Prisma.UserGetPayload<object>['track'];
  note: string | null;
  statusReason?: string | null;
  statusExpiresAt?: Date | string | null;
  updatedAt: Date | string;
  securitySessions?: Array<{ lastSeenAt: Date | string }>;
};

export const serializeUser = (user: SerializableUser) => {
  const presence = getPresenceSnapshot(user.username);
  const latestSessionSeenAt = user.securitySessions?.[0]?.lastSeenAt;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: normalizeUserRole(user.role, user.level),
    status: user.accountStatus,
    level: user.level,
    track: user.track,
    note: user.note ?? '',
    statusReason: user.statusReason ?? undefined,
    statusExpiresAt: user.statusExpiresAt ? new Date(user.statusExpiresAt).toISOString() : undefined,
    updatedAt: dateOnly(user.updatedAt),
    online: presence.online,
    lastSeenAt: presence.lastSeenAt ?? (latestSessionSeenAt ? new Date(latestSessionSeenAt).toISOString() : undefined)
  };
};

type GalleryWithTags = Prisma.GalleryItemGetPayload<{ include: { tags: true; uploader: true } }>;

export const serializeGalleryItem = (
  item: GalleryWithTags,
  comments: unknown[] = [],
  metrics: ContentMetricSummary = emptyMetric,
  viewer?: ViewerEngagement
) => ({
  id: item.id,
  type: item.type === MediaType.video ? 'video' : 'image',
  title: item.title,
  thumbnail: item.thumbnail ?? '',
  mediaUrl: item.mediaUrl ?? undefined,
  videoUrl: item.videoUrl ?? undefined,
  caption: item.caption,
  tags: item.tags.map((tag) => tag.tag),
  date: dateOnly(item.uploadDate),
  uploadedBy:
    item.uploader?.accountStatus === AccountStatus.deleted ? 'Deleted User' : item.uploader?.username ?? item.uploadedBy,
  uploadedByStatus: item.uploader?.accountStatus ?? undefined,
  views: metrics.views,
  likes: metrics.likes,
  dislikes: metrics.dislikes,
  viewerReaction: viewer?.reaction ?? null,
  comments
});

type EntityDocRecord = Prisma.EntityDocGetPayload<object>;
type LoreRecord = Prisma.LoreItemGetPayload<object>;
type DiscussionRecord = Prisma.CommentGetPayload<{ include: { author: true; replies: { include: { author: true } } } }>;

export const serializeDoc = (doc: EntityDocRecord) => ({
  type: doc.type === MediaType.video ? 'video' : doc.type === MediaType.file ? 'file' : 'image',
  url: doc.url,
  thumbnail: doc.thumbnail ?? '',
  caption: doc.caption ?? '',
  ...(doc.date ? { date: doc.date } : {})
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
    author: comment.author.accountStatus === AccountStatus.deleted ? 'Deleted User' : comment.author.username,
    authorStatus: comment.author.accountStatus,
    text: comment.text,
    date: dateOnly(comment.createdAt),
    mentions: extractTextMentions(comment.text),
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      author: reply.author.accountStatus === AccountStatus.deleted ? 'Deleted User' : reply.author.username,
      authorStatus: reply.author.accountStatus,
      text: reply.text,
      date: dateOnly(reply.createdAt),
      mentions: extractTextMentions(reply.text)
    }))
  }));

export const serializeLoreItem = (
  item: LoreRecord,
  docs: EntityDocRecord[] = [],
  discussions?: DiscussionRecord[],
  metrics: ContentMetricSummary = emptyMetric,
  viewer?: ViewerEngagement
) => {
  const metadata = asObject(item.metadata);
  const common = {
    ...metadata,
    id: item.id,
    thumbnail: item.thumbnail ?? '',
    headerImage: typeof metadata.headerImage === 'string' ? metadata.headerImage : undefined,
    shortDesc: item.shortDesc,
    fullDesc: item.fullDesc,
    docs: sortDocsByDateDesc(docs.map(serializeDoc)),
    ...(discussions ? { discussions: serializeDiscussionComments(discussions) } : {}),
    contributor: metadata.contributor,
    meta: metadata.meta,
    views: metrics.views,
    stars: metrics.stars,
    viewerStarred: Boolean(viewer?.starred)
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
