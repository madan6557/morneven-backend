import { EntityType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { deleteFileFromStorage, listStorageObjects, type StorageObjectEntry } from '../config/storage.js';
import { env } from '../config/env.js';
import { isReadableObjectPath, normalizeObjectPath } from '../modules/files/object-path.js';

type JsonRecord = Record<string, unknown>;

export type StorageCleanupReport = {
  scannedAt: string;
  totalObjects: number;
  totalBytes: number;
  referencedObjects: number;
  referencedBytes: number;
  orphanedObjects: number;
  orphanedBytes: number;
  deletedObjects: number;
  deletedBytes: number;
  folders: Array<{
    folder: string;
    totalObjects: number;
    referencedObjects: number;
    orphanedObjects: number;
    orphanedBytes: number;
  }>;
  sampleOrphans: Array<{
    objectPath: string;
    size?: number;
    lastModified?: string;
  }>;
  automaticCleanup: {
    enabled: true;
    scopes: string[];
  };
};

type ProjectAssetRecord = {
  thumbnail: string | null;
  docs: Prisma.JsonValue | null;
  meta: Prisma.JsonValue | null;
};

type LoreAssetRecord = {
  thumbnail: string | null;
  metadata: Prisma.JsonValue | null;
};

const STORAGE_URL_RE = /https?:\/\/(?:[^/]+\.)?storageapi\.dev\/[^/]+\/(.+)/i;
const S3_URL_RE = /https?:\/\/[^/]+\.s3\.(?:amazonaws\.com|[^/]+)\/(.+)/i;
const S3_PROTOCOL_RE = /s3:\/\/[^/]+\/(.+)/i;
const APP_ROUTE_RE = /^(?:lore\/(?:characters\/char-|creatures\/creature-|places\/place-|technology\/tech-|events\/(?:evt-|event-)|other\/other-)|projects\/proj-|gallery\/gal-|news\/news-|maps?|chat)(?:[a-z0-9_-]+)?$/i;
const BOT_MANAGER_WORKSPACE_PREFIX = 'bot-manager/workspace/';
const BOT_MANAGER_BACKUP_PREFIX = 'bot-manager/backups/';
const BACKUP_PREFIX = 'backups/';

const asObject = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const addPath = (set: Set<string>, rawValue: unknown) => {
  const objectPath = extractStorageObjectPath(rawValue);
  if (objectPath) set.add(objectPath);
};

const isApplicationRoutePath = (value: string) => APP_ROUTE_RE.test(normalizeObjectPath(value));

const isBackupArtifactObjectPath = (objectPath: string) => {
  const normalized = normalizeObjectPath(objectPath).toLowerCase();
  return normalized.startsWith(BOT_MANAGER_BACKUP_PREFIX) || normalized.startsWith(BACKUP_PREFIX);
};

export const extractStorageObjectPath = (rawValue: unknown): string | null => {
  if (typeof rawValue !== 'string') return null;
  const value = rawValue.trim();
  if (!value || value.startsWith('data:')) return null;

  if (value.startsWith('/api/files/object') || value.startsWith('/v1/files/object')) {
    const query = value.split('?')[1] ?? '';
    const params = new URLSearchParams(query);
    const pathValue = params.get('path');
    if (!pathValue) return null;
    const decoded = normalizeObjectPath(decodeURIComponent(pathValue));
    return isReadableObjectPath(decoded) ? decoded : null;
  }

  if (value.startsWith(env.localStorageBasePath)) {
    const trimmed = normalizeObjectPath(value.slice(env.localStorageBasePath.length));
    return isReadableObjectPath(trimmed) ? trimmed : null;
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.pathname.startsWith(`${env.localStorageBasePath}/`)) {
        const localPath = normalizeObjectPath(url.pathname.slice(env.localStorageBasePath.length));
        return isReadableObjectPath(localPath) ? localPath : null;
      }

      if (url.pathname.endsWith('/api/files/object') || url.pathname.endsWith('/v1/files/object')) {
        const pathValue = url.searchParams.get('path');
        if (!pathValue) return null;
        const decoded = normalizeObjectPath(decodeURIComponent(pathValue));
        return isReadableObjectPath(decoded) ? decoded : null;
      }
    }
  } catch {
    // Ignore malformed URL parsing and continue with regex extraction.
  }

  const storageMatch = value.match(STORAGE_URL_RE);
  if (storageMatch?.[1]) {
    const objectPath = normalizeObjectPath(storageMatch[1]);
    return isReadableObjectPath(objectPath) ? objectPath : null;
  }

  const s3Match = value.match(S3_URL_RE);
  if (s3Match?.[1]) {
    const objectPath = normalizeObjectPath(s3Match[1]);
    return isReadableObjectPath(objectPath) ? objectPath : null;
  }

  const s3ProtocolMatch = value.match(S3_PROTOCOL_RE);
  if (s3ProtocolMatch?.[1]) {
    const objectPath = normalizeObjectPath(s3ProtocolMatch[1]);
    return isReadableObjectPath(objectPath) ? objectPath : null;
  }

  const normalized = normalizeObjectPath(value);
  if (isApplicationRoutePath(normalized)) return null;
  return isReadableObjectPath(normalized) ? normalized : null;
};

const collectProjectStoragePaths = (project: ProjectAssetRecord) => {
  const paths = new Set<string>();
  addPath(paths, project.thumbnail);

  for (const doc of asArray(project.docs)) {
    const entry = asObject(doc);
    addPath(paths, entry.url);
    addPath(paths, entry.thumbnail);
  }

  const meta = asObject(project.meta);
  addPath(paths, meta.headerImage);
  for (const feature of asArray(meta.features)) {
    addPath(paths, asObject(feature).icon);
  }

  return paths;
};

const collectLoreStoragePaths = (item: LoreAssetRecord, docs: Array<{ url: string; thumbnail?: string | null }>) => {
  const paths = new Set<string>();
  addPath(paths, item.thumbnail);

  const metadata = asObject(item.metadata);
  addPath(paths, metadata.headerImage);
  addPath(paths, metadata.profileImage);

  for (const skill of asArray(metadata.skills)) {
    addPath(paths, asObject(skill).icon);
  }

  for (const feature of asArray(metadata.features)) {
    addPath(paths, asObject(feature).icon);
  }

  for (const doc of docs) {
    addPath(paths, doc.url);
    addPath(paths, doc.thumbnail);
  }

  return paths;
};

const collectNewsStoragePaths = (item: { thumbnail: string | null; attachments: Array<{ url: string }> }) => {
  const paths = new Set<string>();
  addPath(paths, item.thumbnail);
  for (const attachment of item.attachments) {
    addPath(paths, attachment.url);
  }
  return paths;
};

const collectGalleryStoragePaths = (item: { thumbnail: string | null; mediaUrl?: string | null; videoUrl: string | null }) => {
  const paths = new Set<string>();
  addPath(paths, item.thumbnail);
  addPath(paths, item.mediaUrl ?? null);
  addPath(paths, item.videoUrl);
  return paths;
};

const collectChatStoragePaths = (attachments: Prisma.JsonValue | null) => {
  const paths = new Set<string>();
  for (const attachment of asArray(attachments)) {
    const record = asObject(attachment);
    addPath(paths, record.objectPath);
    addPath(paths, record.dataUrl);
    addPath(paths, record.thumbnailUrl);
    addPath(paths, record.url);
  }
  return paths;
};

export const collectReferencedStoragePaths = async (): Promise<Set<string>> => {
  const [
    projects,
    loreItems,
    loreDocs,
    news,
    gallery,
    mapImage,
    chatMessages,
    extractionJobs,
    botManagerIdentities,
    botManagerFiles,
    botManagerBackupJobs,
    storageObjects
  ] = await Promise.all([
    prisma.project.findMany({ select: { thumbnail: true, docs: true, meta: true } }),
    prisma.loreItem.findMany({ select: { id: true, category: true, thumbnail: true, metadata: true } }),
    prisma.entityDoc.findMany({ select: { entityId: true, entityType: true, url: true, thumbnail: true } }),
    prisma.news.findMany({ select: { thumbnail: true, attachments: { select: { url: true } } } }),
    prisma.galleryItem.findMany({ select: { thumbnail: true, mediaUrl: true, videoUrl: true } }),
    prisma.mapImage.findUnique({ where: { id: 'main' }, select: { imageUrl: true } }),
    prisma.chatMessage.findMany({ select: { attachments: true } }),
    prisma.extractionJob.findMany({ where: { expiresAt: { gt: new Date() } }, select: { artifactPath: true, artifactUrl: true } }),
    prisma.botManagerIdentity.findMany({ select: { profileImageObjectPath: true, profileImageUrl: true } }),
    prisma.botManagerIdentityFile.findMany({ select: { objectPath: true } }),
    prisma.botManagerBackupJob.findMany({ where: { expiresAt: { gt: new Date() } }, select: { artifactPath: true, artifactUrl: true } }),
    listStorageObjects()
  ]);

  const docsByEntity = new Map<string, Array<{ url: string; thumbnail?: string | null }>>();
  for (const doc of loreDocs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), { url: doc.url, thumbnail: doc.thumbnail }]);
  }

  const paths = new Set<string>();

  for (const project of projects) {
    for (const entry of collectProjectStoragePaths(project)) {
      paths.add(entry);
    }
  }

  for (const item of loreItems) {
    const key = `${item.category}:${item.id}`;
    for (const entry of collectLoreStoragePaths(item, docsByEntity.get(key) ?? [])) {
      paths.add(entry);
    }
  }

  for (const item of news) {
    for (const entry of collectNewsStoragePaths(item)) {
      paths.add(entry);
    }
  }

  for (const item of gallery) {
    for (const entry of collectGalleryStoragePaths(item)) {
      paths.add(entry);
    }
  }

  addPath(paths, mapImage?.imageUrl);

  for (const message of chatMessages) {
    for (const entry of collectChatStoragePaths(message.attachments)) {
      paths.add(entry);
    }
  }

  for (const job of extractionJobs) {
    addPath(paths, job.artifactPath);
    addPath(paths, job.artifactUrl);
  }

  for (const identity of botManagerIdentities) {
    addPath(paths, identity.profileImageObjectPath);
    addPath(paths, identity.profileImageUrl);
  }

  for (const file of botManagerFiles) {
    addPath(paths, file.objectPath);
  }

  for (const job of botManagerBackupJobs) {
    addPath(paths, job.artifactPath);
    addPath(paths, job.artifactUrl);
  }

  for (const object of storageObjects) {
    if (
      object.objectPath.startsWith(BOT_MANAGER_WORKSPACE_PREFIX)
      && !isBackupArtifactObjectPath(object.objectPath)
    ) {
      paths.add(object.objectPath);
    }
  }

  return paths;
};

const summarizeFolders = (entries: StorageObjectEntry[], referenced: Set<string>) => {
  const byFolder = new Map<string, {
    folder: string;
    totalObjects: number;
    referencedObjects: number;
    orphanedObjects: number;
    orphanedBytes: number;
  }>();

  for (const entry of entries) {
    const folder = entry.objectPath.split('/')[0] ?? 'unknown';
    const summary = byFolder.get(folder) ?? {
      folder,
      totalObjects: 0,
      referencedObjects: 0,
      orphanedObjects: 0,
      orphanedBytes: 0
    };

    summary.totalObjects += 1;
    if (referenced.has(entry.objectPath)) {
      summary.referencedObjects += 1;
    } else {
      summary.orphanedObjects += 1;
      summary.orphanedBytes += entry.size ?? 0;
    }

    byFolder.set(folder, summary);
  }

  return Array.from(byFolder.values()).sort((a, b) => a.folder.localeCompare(b.folder));
};

export const getStorageCleanupReport = async (): Promise<StorageCleanupReport> => {
  const [entries, referenced] = await Promise.all([listStorageObjects(), collectReferencedStoragePaths()]);
  const orphaned = entries.filter((entry) => !referenced.has(entry.objectPath));
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const orphanedBytes = orphaned.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const referencedBytes = totalBytes - orphanedBytes;

  return {
    scannedAt: new Date().toISOString(),
    totalObjects: entries.length,
    totalBytes,
    referencedObjects: entries.length - orphaned.length,
    referencedBytes,
    orphanedObjects: orphaned.length,
    orphanedBytes,
    deletedObjects: 0,
    deletedBytes: 0,
    folders: summarizeFolders(entries, referenced),
    sampleOrphans: orphaned.slice(0, 25).map((entry) => ({
      objectPath: entry.objectPath,
      size: entry.size,
      lastModified: entry.lastModified?.toISOString()
    })),
    automaticCleanup: {
      enabled: true,
      scopes: ['projects', 'lore', 'news', 'gallery', 'map', 'chat', 'bot-manager', 'extraction-history']
    }
  };
};

export const runStorageCleanup = async (): Promise<StorageCleanupReport> => {
  const [entries, referenced] = await Promise.all([listStorageObjects(), collectReferencedStoragePaths()]);
  const orphaned = entries.filter((entry) => !referenced.has(entry.objectPath));
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const orphanedBytes = orphaned.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const referencedBytes = totalBytes - orphanedBytes;

  for (const entry of orphaned) {
    await deleteFileFromStorage(entry.objectPath);
  }

  return {
    scannedAt: new Date().toISOString(),
    totalObjects: entries.length,
    totalBytes,
    referencedObjects: entries.length - orphaned.length,
    referencedBytes,
    orphanedObjects: orphaned.length,
    orphanedBytes,
    deletedObjects: orphaned.length,
    deletedBytes: orphanedBytes,
    folders: summarizeFolders(entries, referenced),
    sampleOrphans: orphaned.slice(0, 25).map((entry) => ({
      objectPath: entry.objectPath,
      size: entry.size,
      lastModified: entry.lastModified?.toISOString()
    })),
    automaticCleanup: {
      enabled: true,
      scopes: ['projects', 'lore', 'news', 'gallery', 'map', 'chat', 'bot-manager', 'extraction-history']
    }
  };
};

export const cleanupUnreferencedStoragePaths = async (candidates: Iterable<string | null | undefined>) => {
  const normalized = Array.from(
    new Set(
      Array.from(candidates)
        .map((candidate) => extractStorageObjectPath(candidate))
        .filter((value): value is string => Boolean(value))
    )
  );

  if (!normalized.length) {
    return { deletedPaths: [] as string[] };
  }

  const referenced = await collectReferencedStoragePaths();
  const deletable = normalized.filter((objectPath) => !referenced.has(objectPath));

  for (const objectPath of deletable) {
    await deleteFileFromStorage(objectPath);
  }

  return { deletedPaths: deletable };
};

export const diffStoragePaths = (before: Set<string>, after: Set<string>) =>
  Array.from(before).filter((objectPath) => !after.has(objectPath));

export const collectProjectStoragePathSet = collectProjectStoragePaths;
export const collectLoreStoragePathSet = collectLoreStoragePaths;
export const collectNewsStoragePathSet = collectNewsStoragePaths;
export const collectGalleryStoragePathSet = collectGalleryStoragePaths;
export const collectChatStoragePathSet = collectChatStoragePaths;
