import { NextFunction, Request, Response, Router } from 'express';
import { raw } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { EntityType, MediaType, Prisma, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth, hasPl7MaintenanceAccess, isPl7Author } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { saveFileToStorage } from '../../config/storage.js';
import { readFileFromStorage } from '../../config/storage.js';
import { readFileWithMetadataFromStorage } from '../../config/storage.js';
import { createReadStreamFromStorage } from '../../config/storage.js';
import { fail, ok } from '../../utils/response.js';
import {
  serializeGalleryItem,
  serializeLoreItem,
  serializeProject,
  serializeUser
} from '../../utils/serializers.js';
import { makeZip, ZipFile } from '../../utils/zip.js';
import { writeAudit } from '../../utils/audit.js';
import { defaultCommandCenterSettings, ensureActiveCommandCenterPreset } from './preset-service.js';
import {
  cleanupUnreferencedStoragePaths,
  collectReferencedStoragePaths,
  extractStorageObjectPath,
  getStorageCleanupReport,
  runStorageCleanup
} from '../../utils/storage-cleanup.js';
import { emitToUser } from '../../realtime/events.js';

export const settingsRouter = Router();
const passwordResetRequestModel = (prisma as any).passwordResetRequest as {
  findMany: (args?: Record<string, unknown>) => Promise<any[]>;
  count: () => Promise<number>;
};

const defaultSettings = defaultCommandCenterSettings;

const settingsSchema = z.object({
  showStats: z.boolean().optional(),
  showProjects: z.boolean().optional(),
  showNews: z.boolean().optional(),
  showCharacters: z.boolean().optional(),
  showPlaces: z.boolean().optional(),
  showTechnology: z.boolean().optional(),
  showGallery: z.boolean().optional(),
  showQuickActions: z.boolean().optional(),
  welcomeMessage: z.string().max(300).optional(),
  itemLimits: z.record(z.coerce.number().int().min(0).max(100)).optional(),
  manualSelections: z.record(z.array(z.string())).optional()
});
const presetCreateSchema = z.object({
  presetKey: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
  presetName: z.string().min(2).max(120),
  settings: settingsSchema.optional()
});
const presetUpdateSchema = z.object({
  presetKey: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).optional(),
  presetName: z.string().min(2).max(120).optional(),
  settings: settingsSchema.optional()
});

const backupMediaSourceSchema = z.enum([
  'chat',
  'gallery',
  'characters',
  'creatures',
  'places',
  'technology',
  'events',
  'other',
  'projects',
  'news',
  'map'
]);
type BackupMediaSource = z.infer<typeof backupMediaSourceSchema>;

const defaultBackupMediaSources: BackupMediaSource[] = [
  'chat',
  'gallery',
  'characters',
  'creatures',
  'places',
  'technology',
  'events',
  'other',
  'projects',
  'news',
  'map'
];

const extractionSchema = z.object({
  mode: z.enum(['db', 'images', 'all']),
  mediaSources: z.array(backupMediaSourceSchema).optional().default(defaultBackupMediaSources),
  autoDownload: z.boolean().optional().default(false),
  confirmText: z.literal('CONFIRM'),
  password: z.string().min(1),
  secretKey: z.string().min(16)
});

const migrationSchema = z
  .object({
    newBaseUrl: z.string().url().optional().or(z.literal('')),
    migrationUrl: z.string().url().optional().or(z.literal('')),
    confirmText: z.literal('MIGRATION'),
    password: z.string().min(1),
    secretKey: z.string().min(16)
  })
  .superRefine((value, ctx) => {
    const hasBaseUrl = Boolean(value.newBaseUrl);
    const hasMigrationUrl = Boolean(value.migrationUrl);
    if (hasBaseUrl === hasMigrationUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one migration target',
        path: ['migrationUrl']
      });
    }
  });

const clearExtractionSchema = z.object({
  ids: z.array(z.string()).optional()
});

const extractionDownloadTicketSchema = z.object({
  secretKey: z.string().min(16)
});

const canUpdateCommandCenter = (user: NonNullable<Express.Request['user']>) =>
  user.role === Role.author || user.level === 7 || (user.level === 6 && user.track === Track.executive);

const mergeSettings = (settings?: Record<string, unknown> | null) => ({
  ...defaultSettings,
  ...(settings ?? {}),
  itemLimits: {
    ...defaultSettings.itemLimits,
    ...((settings?.itemLimits as Record<string, number> | undefined) ?? {})
  },
  manualSelections: {
    ...defaultSettings.manualSelections,
    ...((settings?.manualSelections as Record<string, string[]> | undefined) ?? {})
  }
});

settingsRouter.get('/command-center/defaults', auth, async (_req, res) => ok(res, defaultSettings));

settingsRouter.get('/command-center', auth, async (req, res) => {
  const settings = await ensureActiveCommandCenterPreset('system');
  return ok(res, mergeSettings(settings as Record<string, unknown> | null));
});

settingsRouter.put('/command-center', auth, async (req, res) => {
  if (!canUpdateCommandCenter(req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const merged = mergeSettings(parsed.data);
  const active = await ensureActiveCommandCenterPreset(req.user!.username);
  const saved = active
    ? await prisma.commandCenterSettings.update({
        where: { id: active.id },
        data: { ...merged, updatedBy: req.user!.username }
      })
    : await prisma.commandCenterSettings.create({
        data: { presetKey: 'default', presetName: 'Default System Preset', isActive: true, ...merged, updatedBy: req.user!.username }
      });

  return ok(res, mergeSettings(saved as Record<string, unknown>));
});

settingsRouter.get('/command-center/presets', auth, async (_req, res) => {
  const presets = await prisma.commandCenterSettings.findMany({
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true, presetKey: true, presetName: true, isActive: true, updatedBy: true, updatedAt: true, createdAt: true }
  });
  return ok(res, presets);
});

settingsRouter.post('/command-center/presets', auth, async (req, res) => {
  if (!canUpdateCommandCenter(req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const parsed = presetCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const merged = mergeSettings(parsed.data.settings);
  const created = await prisma.commandCenterSettings.create({
    data: {
      presetKey: parsed.data.presetKey,
      presetName: parsed.data.presetName,
      isActive: false,
      ...merged,
      updatedBy: req.user!.username
    }
  });
  return res.status(201).json({ success: true, data: created });
});

settingsRouter.post('/command-center/presets/:id/activate', auth, async (req, res) => {
  if (!canUpdateCommandCenter(req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const existing = await prisma.commandCenterSettings.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Preset not found', 'NOT_FOUND');
  const [, activated] = await prisma.$transaction([
    prisma.commandCenterSettings.updateMany({ where: { isActive: true }, data: { isActive: false } }),
    prisma.commandCenterSettings.update({ where: { id: req.params.id }, data: { isActive: true, updatedBy: req.user!.username } })
  ]);
  return ok(res, activated);
});

settingsRouter.put('/command-center/presets/:id', auth, async (req, res) => {
  if (!canUpdateCommandCenter(req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const parsed = presetUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const existing = await prisma.commandCenterSettings.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Preset not found', 'NOT_FOUND');

  const merged = parsed.data.settings ? mergeSettings(parsed.data.settings) : null;
  const updated = await prisma.commandCenterSettings.update({
    where: { id: req.params.id },
    data: {
      ...(parsed.data.presetKey !== undefined ? { presetKey: parsed.data.presetKey } : {}),
      ...(parsed.data.presetName !== undefined ? { presetName: parsed.data.presetName } : {}),
      ...(merged ?? {}),
      updatedBy: req.user!.username
    }
  });
  return ok(res, updated);
});

settingsRouter.delete('/command-center/presets/:id', auth, async (req, res) => {
  if (!canUpdateCommandCenter(req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const existing = await prisma.commandCenterSettings.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Preset not found', 'NOT_FOUND');
  if (existing.isActive) return fail(res, 409, 'Active preset cannot be deleted', 'CONFLICT');

  await prisma.commandCenterSettings.delete({ where: { id: req.params.id } });
  return ok(res, { deleted: true, id: req.params.id });
});

const requirePl7 = (req: Request, res: Response) => {
  if (!req.user || !hasPl7MaintenanceAccess(req.user)) {
    fail(res, 403, 'PL7 access required', 'FORBIDDEN');
    return false;
  }
  return true;
};

const requirePl7Author = (req: Request, res: Response) => {
  if (!req.user || !isPl7Author(req.user)) {
    fail(res, 403, 'PL7 author access required', 'FORBIDDEN');
    return false;
  }
  return true;
};

type ExportSnapshot = {
  characters: ReturnType<typeof serializeLoreItem>[];
  creatures: ReturnType<typeof serializeLoreItem>[];
  places: ReturnType<typeof serializeLoreItem>[];
  projects: ReturnType<typeof serializeProject>[];
  technology: ReturnType<typeof serializeLoreItem>[];
  events: ReturnType<typeof serializeLoreItem>[];
  others: ReturnType<typeof serializeLoreItem>[];
  gallery: ReturnType<typeof serializeGalleryItem>[];
  news: Array<{
    id: string;
    text: string;
    date: string;
    hasDetail: boolean;
    thumbnail?: string;
    body?: string;
    attachments: Array<{ type: 'image' | 'video' | 'link'; url: string; caption?: string }>;
  }>;
  personnel: ReturnType<typeof serializeUser>[];
  passwordResetRequests: Array<{
    id: string;
    email: string;
    username: string;
    identityProof: string;
    status: string;
    reviewNote?: string;
    reviewedBy?: string;
    newPasswordHash: string;
    createdAt: string;
    updatedAt: string;
    reviewedAt?: string;
    completedAt?: string;
  }>;
  personnelReports: Array<{
    id: string;
    reporterUsername: string;
    targetUsername: string;
    category: string;
    details: string;
    status: string;
    resolutionAction?: string;
    resolutionNote?: string;
    resolvedByUsername?: string;
    createdAt: string;
    updatedAt: string;
    resolvedAt?: string;
  }>;
  contentMetrics: Awaited<ReturnType<typeof prisma.contentMetric.findMany>>;
  contentViewEvents: Awaited<ReturnType<typeof prisma.contentViewEvent.findMany>>;
  contentReactions: Awaited<ReturnType<typeof prisma.contentReaction.findMany>>;
  map: {
    mapImage: string;
    markers: Awaited<ReturnType<typeof prisma.mapMarker.findMany>>;
  };
};

type EmbeddedAsset = {
  objectPath: string;
  archivePath: string;
  source: BackupMediaSource;
  size?: number;
  contentType?: string;
};

type ExtractionBuildResult = {
  files: ZipFile[];
  mediaSummary: {
    embeddedCount: number;
    failedCount: number;
    selectedSources: BackupMediaSource[];
  };
};

const serializeNewsForExtraction = (item: Prisma.NewsGetPayload<{ include: { attachments: true } }>): ExportSnapshot['news'][number] => ({
  id: item.id,
  text: item.text,
  date: item.publishDate.toISOString().slice(0, 10),
  hasDetail: item.hasDetail,
  thumbnail: item.thumbnail ?? undefined,
  body: item.body ?? undefined,
  attachments: item.attachments.map((attachment) => ({
    type: attachment.type === MediaType.link ? 'link' : attachment.type === MediaType.video ? 'video' : 'image',
    url: attachment.url,
    caption: attachment.caption ?? undefined
  }))
});

const serializePasswordResetRequestForExtraction = (
  item: {
    id: string;
    email: string;
    username: string;
    identityProof: string;
    status: string;
    reviewNote?: string | null;
    reviewedBy?: { username: string } | null;
    newPasswordHash: string;
    createdAt: Date;
    updatedAt: Date;
    reviewedAt?: Date | null;
    completedAt?: Date | null;
  }
): ExportSnapshot['passwordResetRequests'][number] => ({
  id: item.id,
  email: item.email,
  username: item.username,
  identityProof: item.identityProof,
  status: item.status,
  reviewNote: item.reviewNote ?? undefined,
  reviewedBy: item.reviewedBy?.username ?? undefined,
  newPasswordHash: item.newPasswordHash,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  reviewedAt: item.reviewedAt?.toISOString(),
  completedAt: item.completedAt?.toISOString()
});

const serializePersonnelReportForExtraction = (
  item: Prisma.PersonnelReportGetPayload<{ include: { reporter: true; target: true; resolvedBy: true } }>
): ExportSnapshot['personnelReports'][number] => ({
  id: item.id,
  reporterUsername: item.reporter.username,
  targetUsername: item.target.username,
  category: item.category,
  details: item.details,
  status: item.status,
  resolutionAction: item.resolutionAction ?? undefined,
  resolutionNote: item.resolutionNote ?? undefined,
  resolvedByUsername: item.resolvedBy?.username ?? undefined,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  resolvedAt: item.resolvedAt?.toISOString()
});

const collectExtractionSnapshot = async (): Promise<ExportSnapshot> => {
  const [
    projects,
    gallery,
    news,
    personnel,
    passwordResetRequests,
    personnelReports,
    contentMetrics,
    contentViewEvents,
    contentReactions,
    mapMarkers,
    mapImage,
    lore,
    docs
  ] = await Promise.all([
    prisma.project.findMany({ include: { patches: true } }),
    prisma.galleryItem.findMany({ include: { tags: true, uploader: true } }),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.user.findMany(),
    passwordResetRequestModel.findMany({ include: { reviewedBy: true } }),
    prisma.personnelReport.findMany({ include: { reporter: true, target: true, resolvedBy: true } }),
    prisma.contentMetric.findMany(),
    prisma.contentViewEvent.findMany(),
    prisma.contentReaction.findMany(),
    prisma.mapMarker.findMany(),
    prisma.mapImage.findUnique({ where: { id: 'main' } }),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany()
  ]);

  const docsByEntity = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), doc]);
  }

  const loreByType = (category: EntityType) =>
    lore
      .filter((item) => item.category === category)
      .map((item) => serializeLoreItem(item, docsByEntity.get(`${item.category}:${item.id}`) ?? []));

  return {
    characters: loreByType(EntityType.character),
    creatures: loreByType(EntityType.creature),
    places: loreByType(EntityType.place),
    projects: projects.map(serializeProject),
    technology: loreByType(EntityType.technology),
    events: loreByType(EntityType.event),
    others: loreByType(EntityType.other),
    gallery: gallery.map((item) => serializeGalleryItem(item)),
    news: news.map(serializeNewsForExtraction),
    personnel: personnel.map(serializeUser),
    passwordResetRequests: passwordResetRequests.map(serializePasswordResetRequestForExtraction),
    personnelReports: personnelReports.map(serializePersonnelReportForExtraction),
    contentMetrics,
    contentViewEvents,
    contentReactions,
    map: {
      mapImage: mapImage?.imageUrl ?? '',
      markers: mapMarkers
    }
  };
};

const collectStoragePathsFromValue = (value: unknown, target = new Set<string>()) => {
  if (typeof value === 'string') {
    const objectPath = extractStorageObjectPath(value);
    if (objectPath) target.add(objectPath);
    return target;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectStoragePathsFromValue(entry, target);
    return target;
  }

  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStoragePathsFromValue(entry, target);
  }

  return target;
};

const rewriteExportMediaPaths = <T>(value: T, embeddedAssets: Map<string, EmbeddedAsset>): T => {
  if (typeof value === 'string') {
    const objectPath = extractStorageObjectPath(value);
    if (!objectPath) return value;
    return (embeddedAssets.get(objectPath)?.archivePath ?? value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => rewriteExportMediaPaths(entry, embeddedAssets)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewriteExportMediaPaths(entry, embeddedAssets)])
    ) as T;
  }

  return value;
};

const galleryImageByTag = (gallery: ExportSnapshot['gallery'], tag: string) =>
  gallery.filter((item) => item.type === 'image' && item.tags.includes(tag));

const buildImageManifests = (snapshot: ExportSnapshot): Array<{ name: string; value: unknown }> => [
  { name: 'images/map/images.json', value: [{ title: 'map', src: snapshot.map.mapImage }] },
  { name: 'images/character/images.json', value: galleryImageByTag(snapshot.gallery, 'character') },
  { name: 'images/creature/images.json', value: galleryImageByTag(snapshot.gallery, 'creature') },
  { name: 'images/technology/images.json', value: galleryImageByTag(snapshot.gallery, 'technology') },
  { name: 'images/environment/images.json', value: galleryImageByTag(snapshot.gallery, 'environment') },
  {
    name: 'images/other/images.json',
    value: snapshot.gallery.filter(
      (item) => item.type === 'image' && !['character', 'creature', 'technology', 'environment'].some((tag) => item.tags.includes(tag))
    )
  }
];

const addPathSetValue = (target: Set<string>, value: unknown) => {
  const next = collectStoragePathsFromValue(value);
  for (const objectPath of next) target.add(objectPath);
};

const collectBackupMediaPathSets = async (): Promise<Record<BackupMediaSource, Set<string>>> => {
  const sets = Object.fromEntries(defaultBackupMediaSources.map((source) => [source, new Set<string>()])) as Record<
    BackupMediaSource,
    Set<string>
  >;

  const [
    chatMessages,
    galleryItems,
    projects,
    news,
    mapImage,
    loreItems,
    docs
  ] = await Promise.all([
    prisma.chatMessage.findMany({ select: { attachments: true } }),
    prisma.galleryItem.findMany({ include: { tags: true } }),
    prisma.project.findMany(),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.mapImage.findUnique({ where: { id: 'main' } }),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany()
  ]);

  for (const message of chatMessages) addPathSetValue(sets.chat, message.attachments);
  for (const item of galleryItems) addPathSetValue(sets.gallery, item);
  for (const project of projects) addPathSetValue(sets.projects, project);
  for (const item of news) addPathSetValue(sets.news, item);
  addPathSetValue(sets.map, mapImage?.imageUrl);

  const docsByEntity = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), doc]);
  }

  const sourceByEntityType: Partial<Record<EntityType, BackupMediaSource>> = {
    [EntityType.character]: 'characters',
    [EntityType.creature]: 'creatures',
    [EntityType.place]: 'places',
    [EntityType.technology]: 'technology',
    [EntityType.event]: 'events',
    [EntityType.other]: 'other'
  };

  for (const item of loreItems) {
    const source = sourceByEntityType[item.category];
    if (!source) continue;
    addPathSetValue(sets[source], item);
    addPathSetValue(sets[source], docsByEntity.get(`${item.category}:${item.id}`) ?? []);
  }

  return sets;
};

const getSelectedMediaPaths = async (selectedSources: BackupMediaSource[]) => {
  const pathSets = await collectBackupMediaPathSets();
  const unique = new Map<string, BackupMediaSource>();
  for (const source of selectedSources) {
    for (const objectPath of pathSets[source] ?? []) {
      if (!unique.has(objectPath)) unique.set(objectPath, source);
    }
  }
  return {
    pathSets,
    selected: Array.from(unique.entries())
      .map(([objectPath, source]) => ({ objectPath, source }))
      .sort((left, right) => left.objectPath.localeCompare(right.objectPath))
  };
};

const backupReadme = (selectedSources: BackupMediaSource[], embeddedAssets: EmbeddedAsset[], failedAssets: Array<{ objectPath: string; error: string }>) => `# Morneven Backup Attachment Guide

This archive is produced by the Morneven backend backup system.

## Folders

- \`database/morneven-full-backup.sql\`: PostgreSQL restore script for the database snapshot.
- \`db/morneven-full-dataset.json\`: full JSON dataset aligned with the migration payload structure.
- \`db/*.json\`: compatibility JSON exports used by older review and import tooling.
- \`attachments/\`: binary media and attachment files copied from object storage.
- \`attachments/manifest.json\`: object path to archive path mapping for restored media.
- \`images/*.json\`: legacy image manifests with paths rewritten to local archive paths when available.

## Selected Attachment Sources

${selectedSources.map((source) => `- ${source}`).join('\n') || '- none'}

## Restore Notes

1. Restore the SQL into a compatible Morneven PostgreSQL database after the matching Prisma migrations are applied.
2. Upload every file under \`attachments/\` back into the target object storage using the original \`objectPath\` from \`attachments/manifest.json\`.
3. Preserve object paths exactly. Database rows reference storage paths by value.
4. If migrating to another storage provider, translate paths at the storage layer or rewrite DB values consistently before restoring.

## Media Summary

- Embedded assets: ${embeddedAssets.length}
- Failed assets: ${failedAssets.length}
`;

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;
const jsonColumns = new Set([
  'metadata',
  'docs',
  'meta',
  'itemLimits',
  'manualSelections',
  'payload',
  'members',
  'monthly',
  'yearly',
  'supervised',
  'source',
  'attachments',
  'replyTo',
  'progress',
  'config'
]);

const sqlValue = (column: string, value: unknown) => {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return sqlString(value.toISOString());
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' || jsonColumns.has(column)) return `${sqlString(JSON.stringify(value))}::jsonb`;
  return sqlString(String(value));
};

const sqlInsertBlock = (table: string, rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return `-- ${table}: no rows`;
  const columns = Object.keys(rows[0]);
  const columnSql = columns.map(sqlIdent).join(', ');
  const values = rows
    .map((row) => `(${columns.map((column) => sqlValue(column, row[column])).join(', ')})`)
    .join(',\n');
  return `INSERT INTO ${sqlIdent(table)} (${columnSql}) VALUES\n${values};`;
};

const buildDatabaseSqlDump = (dataset: MigrationDataset) => {
  const tables: Array<[string, Array<Record<string, unknown>>]> = [
    ['User', dataset.users as Array<Record<string, unknown>>],
    ['SecuritySession', dataset.securitySessions as Array<Record<string, unknown>>],
    ['CommandCenterSettings', dataset.commandCenterSettings as Array<Record<string, unknown>>],
    ['RefreshToken', dataset.refreshTokens as Array<Record<string, unknown>>],
    ['Project', dataset.projects as Array<Record<string, unknown>>],
    ['ProjectPatch', dataset.projectPatches as Array<Record<string, unknown>>],
    ['News', dataset.news as Array<Record<string, unknown>>],
    ['NewsAttachment', dataset.newsAttachments as Array<Record<string, unknown>>],
    ['LoreItem', dataset.loreItems as Array<Record<string, unknown>>],
    ['EntityDoc', dataset.entityDocs as Array<Record<string, unknown>>],
    ['GalleryItem', dataset.galleryItems as Array<Record<string, unknown>>],
    ['GalleryTag', dataset.galleryTags as Array<Record<string, unknown>>],
    ['MapImage', dataset.mapImages as Array<Record<string, unknown>>],
    ['MapMarker', dataset.mapMarkers as Array<Record<string, unknown>>],
    ['Comment', dataset.comments as Array<Record<string, unknown>>],
    ['Reply', dataset.replies as Array<Record<string, unknown>>],
    ['Mention', dataset.mentions as Array<Record<string, unknown>>],
    ['ContentMetric', dataset.contentMetrics as Array<Record<string, unknown>>],
    ['ContentViewEvent', dataset.contentViewEvents as Array<Record<string, unknown>>],
    ['ContentReaction', dataset.contentReactions as Array<Record<string, unknown>>],
    ['ManagementRequest', dataset.managementRequests as Array<Record<string, unknown>>],
    ['Team', dataset.teams as Array<Record<string, unknown>>],
    ['QuotaRecord', dataset.quotaRecords as Array<Record<string, unknown>>],
    ['Notification', dataset.notifications as Array<Record<string, unknown>>],
    ['NotificationRead', dataset.notificationReads as Array<Record<string, unknown>>],
    ['ChatConversation', dataset.chatConversations as Array<Record<string, unknown>>],
    ['ChatConversationMember', dataset.chatConversationMembers as Array<Record<string, unknown>>],
    ['ChatMessage', dataset.chatMessages as Array<Record<string, unknown>>],
    ['ChatReadState', dataset.chatReadStates as Array<Record<string, unknown>>],
    ['ExtractionJob', dataset.extractionJobs as Array<Record<string, unknown>>],
    ['AuditLog', dataset.auditLogs as Array<Record<string, unknown>>],
    ['SecurityEvent', dataset.securityEvents as Array<Record<string, unknown>>],
    ['SecurityBlock', dataset.securityBlocks as Array<Record<string, unknown>>],
    ['SecurityPolicy', dataset.securityPolicies as Array<Record<string, unknown>>],
    ['FileScanRecord', dataset.fileScanRecords as Array<Record<string, unknown>>],
    ['PersonnelReport', dataset.personnelReports as Array<Record<string, unknown>>],
    ['PasswordResetRequest', dataset.passwordResetRequests as Array<Record<string, unknown>>]
  ];

  return [
    '-- Morneven full database backup',
    `-- Generated at ${new Date().toISOString()}`,
    '-- Apply migrations before restoring this file.',
    'BEGIN;',
    `TRUNCATE TABLE ${tables.map(([table]) => sqlIdent(table)).join(', ')} RESTART IDENTITY CASCADE;`,
    ...tables.map(([table, rows]) => sqlInsertBlock(table, rows)),
    'COMMIT;',
    ''
  ].join('\n\n');
};

const buildExtractionFiles = async (
  mode: 'db' | 'images' | 'all',
  mediaSources: BackupMediaSource[],
  onProgress?: (percent: number, stage: string, message: string) => Promise<void>
): Promise<ExtractionBuildResult> => {
  const files: ZipFile[] = [];
  const snapshot = await collectExtractionSnapshot();
  const includeMedia = mode === 'images' || mode === 'all';
  const selectedSources = includeMedia ? Array.from(new Set(mediaSources)) : [];
  const mediaSelection = includeMedia
    ? await getSelectedMediaPaths(selectedSources)
    : {
        pathSets: Object.fromEntries(defaultBackupMediaSources.map((source) => [source, new Set<string>()])) as Record<BackupMediaSource, Set<string>>,
        selected: [] as Array<{ objectPath: string; source: BackupMediaSource }>
      };
  const { pathSets, selected } = mediaSelection;
  const embeddedAssets = new Map<string, EmbeddedAsset>();
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  if (includeMedia) {
    const totalAssets = selected.length;
    for (let index = 0; index < selected.length; index += 1) {
      const { objectPath, source } = selected[index];
      const progressBase = totalAssets === 0 ? 40 : 10 + Math.round(((index + 1) / totalAssets) * 50);
      await onProgress?.(progressBase, 'collecting-media', `Embedding media ${index + 1} of ${totalAssets}`);
      try {
        const stored = await readFileWithMetadataFromStorage(objectPath);
        const archivePath = `attachments/${objectPath}`;
        embeddedAssets.set(objectPath, {
          objectPath,
          archivePath,
          source,
          size: stored.contentLength,
          contentType: stored.contentType
        });
        files.push({ name: archivePath, content: stored.buffer });
      } catch (error) {
        failedAssets.push({
          objectPath,
          error: error instanceof Error ? error.message : 'Unknown storage read failure'
        });
      }
    }
  }

  const exportedSnapshot =
    includeMedia
      ? rewriteExportMediaPaths(snapshot, embeddedAssets)
      : snapshot;

  if (mode === 'db' || mode === 'all') {
    await onProgress?.(62, 'building-sql', 'Building database SQL backup');
    const dataset = await collectMigrationDataset();
    files.push({ name: 'database/morneven-full-backup.sql', content: buildDatabaseSqlDump(dataset) });
    files.push({ name: 'db/morneven-full-dataset.json', content: JSON.stringify(dataset, null, 2) });
    files.push({ name: 'db/characters.json', content: JSON.stringify(exportedSnapshot.characters, null, 2) });
    files.push({ name: 'db/creatures.json', content: JSON.stringify(exportedSnapshot.creatures, null, 2) });
    files.push({ name: 'db/places.json', content: JSON.stringify(exportedSnapshot.places, null, 2) });
    files.push({ name: 'db/projects.json', content: JSON.stringify(exportedSnapshot.projects, null, 2) });
    files.push({ name: 'db/technology.json', content: JSON.stringify(exportedSnapshot.technology, null, 2) });
    files.push({ name: 'db/events.json', content: JSON.stringify(exportedSnapshot.events, null, 2) });
    files.push({ name: 'db/others.json', content: JSON.stringify(exportedSnapshot.others, null, 2) });
    files.push({ name: 'db/gallery.json', content: JSON.stringify(exportedSnapshot.gallery, null, 2) });
    files.push({ name: 'db/news.json', content: JSON.stringify(exportedSnapshot.news, null, 2) });
    files.push({ name: 'db/personnel.json', content: JSON.stringify(exportedSnapshot.personnel, null, 2) });
    files.push({ name: 'db/password-reset-requests.json', content: JSON.stringify(exportedSnapshot.passwordResetRequests, null, 2) });
    files.push({ name: 'db/personnel-reports.json', content: JSON.stringify(exportedSnapshot.personnelReports, null, 2) });
    files.push({ name: 'db/content-metrics.json', content: JSON.stringify(exportedSnapshot.contentMetrics, null, 2) });
    files.push({ name: 'db/content-view-events.json', content: JSON.stringify(exportedSnapshot.contentViewEvents, null, 2) });
    files.push({ name: 'db/content-reactions.json', content: JSON.stringify(exportedSnapshot.contentReactions, null, 2) });
    files.push({ name: 'db/map.json', content: JSON.stringify(exportedSnapshot.map, null, 2) });
  }

  if (includeMedia) {
    for (const manifest of buildImageManifests(exportedSnapshot)) {
      files.push({ name: manifest.name, content: JSON.stringify(manifest.value, null, 2) });
    }

    files.push({
      name: 'attachments/manifest.json',
      content: JSON.stringify(
        {
          selectedSources,
          sourceObjectCounts: Object.fromEntries(
            Object.entries(pathSets).map(([source, paths]) => [source, paths.size])
          ),
          embeddedAssets: Array.from(embeddedAssets.values()).map((asset) => ({
            objectPath: asset.objectPath,
            archivePath: asset.archivePath,
            source: asset.source,
            size: asset.size,
            contentType: asset.contentType
          })),
          failedAssets
        },
        null,
        2
      )
    });
    files.push({ name: 'attachments/README.md', content: backupReadme(selectedSources, Array.from(embeddedAssets.values()), failedAssets) });
  }

  return {
    files,
    mediaSummary: {
      embeddedCount: embeddedAssets.size,
      failedCount: failedAssets.length,
      selectedSources
    }
  };
};

const extractionProgress = (percent: number, stage: string, message: string) => ({ percent, stage, message });

const serializeExtractionJob = (job: Awaited<ReturnType<typeof prisma.extractionJob.findFirst>> | Awaited<ReturnType<typeof prisma.extractionJob.create>>) => {
  if (!job) return job;
  return {
    ...job,
    progress: job.progress ?? extractionProgress(0, 'queued', 'Queued')
  };
};

const runExtractionJob = async (
  jobId: string,
  mode: 'db' | 'images' | 'all',
  mediaSources: BackupMediaSource[],
  actor: string,
  downloadName: string
) => {
  try {
    const updateProgress = async (percent: number, stage: string, message: string) => {
      const updated = await prisma.extractionJob.update({
        where: { id: jobId },
        data: { progress: extractionProgress(percent, stage, message) }
      });
      emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(updated) as Record<string, unknown> });
    };

    await updateProgress(10, 'collecting', 'Collecting backup data');
    const { files, mediaSummary } = await buildExtractionFiles(mode, mediaSources, updateProgress);

    await updateProgress(70, 'compressing', 'Compressing backup archive');
    const zip = makeZip(files);

    await updateProgress(85, 'uploading', 'Uploading backup artifact');
    const objectPath = `backups/${jobId}/${downloadName}`;
    const stored = await saveFileToStorage({ objectPath, buffer: zip, contentType: 'application/zip' });

    const completed = await prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        artifactPath: stored.objectPath,
        artifactUrl: stored.url,
        progress: extractionProgress(100, 'completed', 'Backup ready')
      }
    });
    emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(completed) as Record<string, unknown> });
    await writeAudit(prisma, {
      actor,
      action: 'extraction.start',
      entity: 'ExtractionJob',
      entityId: completed.id,
      metadata: {
        mode,
        mediaSources: mediaSummary.selectedSources,
        fileCount: files.length,
        embeddedMedia: mediaSummary.embeddedCount,
        failedMedia: mediaSummary.failedCount
      }
    });
  } catch (error) {
    const failed = await prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: (error as Error).message,
        progress: extractionProgress(100, 'failed', 'Backup failed')
      }
    });
    emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(failed) as Record<string, unknown> });
  }
};

type MigrationDataset = {
  users: Awaited<ReturnType<typeof prisma.user.findMany>>;
  passwordResetRequests: any[];
  commandCenterSettings: Awaited<ReturnType<typeof prisma.commandCenterSettings.findMany>>;
  securitySessions: Awaited<ReturnType<typeof prisma.securitySession.findMany>>;
  refreshTokens: Awaited<ReturnType<typeof prisma.refreshToken.findMany>>;
  projects: Awaited<ReturnType<typeof prisma.project.findMany>>;
  projectPatches: Awaited<ReturnType<typeof prisma.projectPatch.findMany>>;
  news: Awaited<ReturnType<typeof prisma.news.findMany>>;
  newsAttachments: Awaited<ReturnType<typeof prisma.newsAttachment.findMany>>;
  loreItems: Awaited<ReturnType<typeof prisma.loreItem.findMany>>;
  entityDocs: Awaited<ReturnType<typeof prisma.entityDoc.findMany>>;
  galleryItems: Awaited<ReturnType<typeof prisma.galleryItem.findMany>>;
  galleryTags: Awaited<ReturnType<typeof prisma.galleryTag.findMany>>;
  mapImages: Awaited<ReturnType<typeof prisma.mapImage.findMany>>;
  mapMarkers: Awaited<ReturnType<typeof prisma.mapMarker.findMany>>;
  comments: Awaited<ReturnType<typeof prisma.comment.findMany>>;
  replies: Awaited<ReturnType<typeof prisma.reply.findMany>>;
  mentions: Awaited<ReturnType<typeof prisma.mention.findMany>>;
  contentMetrics: Awaited<ReturnType<typeof prisma.contentMetric.findMany>>;
  contentViewEvents: Awaited<ReturnType<typeof prisma.contentViewEvent.findMany>>;
  contentReactions: Awaited<ReturnType<typeof prisma.contentReaction.findMany>>;
  managementRequests: Awaited<ReturnType<typeof prisma.managementRequest.findMany>>;
  teams: Awaited<ReturnType<typeof prisma.team.findMany>>;
  quotaRecords: Awaited<ReturnType<typeof prisma.quotaRecord.findMany>>;
  notifications: Awaited<ReturnType<typeof prisma.notification.findMany>>;
  notificationReads: Awaited<ReturnType<typeof prisma.notificationRead.findMany>>;
  chatConversations: Awaited<ReturnType<typeof prisma.chatConversation.findMany>>;
  chatConversationMembers: Awaited<ReturnType<typeof prisma.chatConversationMember.findMany>>;
  chatMessages: Awaited<ReturnType<typeof prisma.chatMessage.findMany>>;
  chatReadStates: Awaited<ReturnType<typeof prisma.chatReadState.findMany>>;
  extractionJobs: Awaited<ReturnType<typeof prisma.extractionJob.findMany>>;
  auditLogs: Awaited<ReturnType<typeof prisma.auditLog.findMany>>;
  securityEvents: Awaited<ReturnType<typeof prisma.securityEvent.findMany>>;
  securityBlocks: Awaited<ReturnType<typeof prisma.securityBlock.findMany>>;
  securityPolicies: Awaited<ReturnType<typeof prisma.securityPolicy.findMany>>;
  fileScanRecords: Awaited<ReturnType<typeof prisma.fileScanRecord.findMany>>;
  personnelReports: Awaited<ReturnType<typeof prisma.personnelReport.findMany>>;
};

type MigrationPayload = {
  version: 1;
  exportedAt: string;
  source: {
    assetEndpoint: string;
  };
  dataset: MigrationDataset;
  assets: Array<{ objectPath: string }>;
  summary: {
    tables: Record<string, number>;
    assetCount: number;
  };
};

type MigrationVerification = {
  tables: Record<string, number>;
  assetCount: number;
  uploadedAssetCount: number;
  failedAssets: Array<{ objectPath: string; error: string }>;
};

const migrationProgress = (percent: number, stage: string, message: string) => ({ percent, stage, message });

const requireMigrationKey = (key?: string | null) => {
  if (!env.migrationKey) throw new Error('MIGRATION_KEY is not configured on this backend');
  if (!key || key !== env.migrationKey) throw new Error('Invalid migration key');
};

const secretEquals = (candidate: string | null | undefined, expected: string) => {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
};

const requireExtractionKey = (key?: string | null) => {
  if (!env.extractionKey) throw new Error('EXTRACTION_KEY is not configured on this backend');
  if (!secretEquals(key, env.extractionKey)) throw new Error('Invalid extraction key');
};

type ExtractionDownloadTicket = {
  jobId: string;
  actor: string;
  exp: number;
  nonce: string;
};

const signTicketPayload = (payload: string) =>
  createHmac('sha256', env.jwtAccessSecret).update(payload).digest('base64url');

const createExtractionDownloadTicket = (jobId: string, actor: string) => {
  const payload: ExtractionDownloadTicket = {
    jobId,
    actor,
    exp: Date.now() + 5 * 60 * 1000,
    nonce: randomUUID()
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signTicketPayload(encodedPayload)}`;
};

const parseExtractionDownloadTicket = (ticket: string): ExtractionDownloadTicket => {
  const [encodedPayload, signature] = ticket.split('.');
  if (!encodedPayload || !signature) throw new Error('Invalid download ticket');
  const expectedSignature = signTicketPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new Error('Invalid download ticket');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as ExtractionDownloadTicket;
  if (!payload.jobId || !payload.actor || !payload.exp || payload.exp < Date.now()) {
    throw new Error('Expired download ticket');
  }
  return payload;
};

const parseMigrationPayload = (buffer: Buffer): MigrationPayload => {
  const parsed = JSON.parse(buffer.toString('utf8')) as MigrationPayload;
  if (!parsed || parsed.version !== 1 || !parsed.dataset || !parsed.source?.assetEndpoint) {
    throw new Error('Invalid migration payload');
  }
  (parsed.dataset as Partial<MigrationDataset>).contentViewEvents ??= [];
  return parsed;
};

const summarizeMigrationDataset = (dataset: MigrationDataset, assetCount: number) => ({
  tables: Object.fromEntries(
    Object.entries(dataset).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])
  ),
  assetCount
});

const collectMigrationDataset = async (): Promise<MigrationDataset> => {
  const [
    users,
    passwordResetRequests,
    commandCenterSettings,
    securitySessions,
    refreshTokens,
    projects,
    projectPatches,
    news,
    newsAttachments,
    loreItems,
    entityDocs,
    galleryItems,
    galleryTags,
    mapImages,
    mapMarkers,
    comments,
    replies,
    mentions,
    contentMetrics,
    contentViewEvents,
    contentReactions,
    managementRequests,
    teams,
    quotaRecords,
    notifications,
    notificationReads,
    chatConversations,
    chatConversationMembers,
    chatMessages,
    chatReadStates,
    extractionJobs,
    auditLogs,
    securityEvents,
    securityBlocks,
    securityPolicies,
    fileScanRecords,
    personnelReports
  ] = await Promise.all([
    prisma.user.findMany(),
    passwordResetRequestModel.findMany(),
    prisma.commandCenterSettings.findMany(),
    prisma.securitySession.findMany(),
    prisma.refreshToken.findMany(),
    prisma.project.findMany(),
    prisma.projectPatch.findMany(),
    prisma.news.findMany(),
    prisma.newsAttachment.findMany(),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany(),
    prisma.galleryItem.findMany(),
    prisma.galleryTag.findMany(),
    prisma.mapImage.findMany(),
    prisma.mapMarker.findMany(),
    prisma.comment.findMany(),
    prisma.reply.findMany(),
    prisma.mention.findMany(),
    prisma.contentMetric.findMany(),
    prisma.contentViewEvent.findMany(),
    prisma.contentReaction.findMany(),
    prisma.managementRequest.findMany(),
    prisma.team.findMany(),
    prisma.quotaRecord.findMany(),
    prisma.notification.findMany(),
    prisma.notificationRead.findMany(),
    prisma.chatConversation.findMany(),
    prisma.chatConversationMember.findMany(),
    prisma.chatMessage.findMany(),
    prisma.chatReadState.findMany(),
    prisma.extractionJob.findMany(),
    prisma.auditLog.findMany({ where: { action: { not: 'migration.job' } } }),
    prisma.securityEvent.findMany(),
    prisma.securityBlock.findMany(),
    prisma.securityPolicy.findMany(),
    prisma.fileScanRecord.findMany(),
    prisma.personnelReport.findMany()
  ]);

  return {
    users,
    passwordResetRequests,
    commandCenterSettings,
    securitySessions,
    refreshTokens,
    projects,
    projectPatches,
    news,
    newsAttachments,
    loreItems,
    entityDocs,
    galleryItems,
    galleryTags,
    mapImages,
    mapMarkers,
    comments,
    replies,
    mentions,
    contentMetrics,
    contentViewEvents,
    contentReactions,
    managementRequests,
    teams,
    quotaRecords,
    notifications,
    notificationReads,
    chatConversations,
    chatConversationMembers,
    chatMessages,
    chatReadStates,
    extractionJobs,
    auditLogs,
    securityEvents,
    securityBlocks,
    securityPolicies,
    fileScanRecords,
    personnelReports
  };
};

const collectMigrationPayload = async (assetEndpoint: string): Promise<MigrationPayload> => {
  const dataset = await collectMigrationDataset();
  const assets = Array.from(await collectReferencedStoragePaths())
    .sort((left, right) => left.localeCompare(right))
    .map((objectPath) => ({ objectPath }));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { assetEndpoint },
    dataset,
    assets,
    summary: summarizeMigrationDataset(dataset, assets.length)
  };
};

const countCurrentMigrationState = async () => {
  const [
    users,
    passwordResetRequests,
    commandCenterSettings,
    securitySessions,
    refreshTokens,
    projects,
    projectPatches,
    news,
    newsAttachments,
    loreItems,
    entityDocs,
    galleryItems,
    galleryTags,
    mapImages,
    mapMarkers,
    comments,
    replies,
    mentions,
    contentMetrics,
    contentViewEvents,
    contentReactions,
    managementRequests,
    teams,
    quotaRecords,
    notifications,
    notificationReads,
    chatConversations,
    chatConversationMembers,
    chatMessages,
    chatReadStates,
    extractionJobs,
    auditLogs,
    securityEvents,
    securityBlocks,
    securityPolicies,
    fileScanRecords,
    personnelReports,
    assets
  ] = await Promise.all([
    prisma.user.count(),
    passwordResetRequestModel.count(),
    prisma.commandCenterSettings.count(),
    prisma.securitySession.count(),
    prisma.refreshToken.count(),
    prisma.project.count(),
    prisma.projectPatch.count(),
    prisma.news.count(),
    prisma.newsAttachment.count(),
    prisma.loreItem.count(),
    prisma.entityDoc.count(),
    prisma.galleryItem.count(),
    prisma.galleryTag.count(),
    prisma.mapImage.count(),
    prisma.mapMarker.count(),
    prisma.comment.count(),
    prisma.reply.count(),
    prisma.mention.count(),
    prisma.contentMetric.count(),
    prisma.contentViewEvent.count(),
    prisma.contentReaction.count(),
    prisma.managementRequest.count(),
    prisma.team.count(),
    prisma.quotaRecord.count(),
    prisma.notification.count(),
    prisma.notificationRead.count(),
    prisma.chatConversation.count(),
    prisma.chatConversationMember.count(),
    prisma.chatMessage.count(),
    prisma.chatReadState.count(),
    prisma.extractionJob.count(),
    prisma.auditLog.count({ where: { action: { not: 'migration.job' } } }),
    prisma.securityEvent.count(),
    prisma.securityBlock.count(),
    prisma.securityPolicy.count(),
    prisma.fileScanRecord.count(),
    prisma.personnelReport.count(),
    collectReferencedStoragePaths()
  ]);

  return {
    tables: {
      users,
      passwordResetRequests,
      commandCenterSettings,
      securitySessions,
      refreshTokens,
      projects,
      projectPatches,
      news,
      newsAttachments,
      loreItems,
      entityDocs,
      galleryItems,
      galleryTags,
      mapImages,
      mapMarkers,
      comments,
      replies,
      mentions,
      contentMetrics,
      contentViewEvents,
      contentReactions,
      managementRequests,
      teams,
      quotaRecords,
      notifications,
      notificationReads,
      chatConversations,
      chatConversationMembers,
      chatMessages,
      chatReadStates,
      extractionJobs,
      auditLogs,
      securityEvents,
      securityBlocks,
      securityPolicies,
      fileScanRecords,
      personnelReports
    },
    assetCount: assets.size
  };
};

const importMigrationDataset = async (dataset: MigrationDataset) => {
  await prisma.$transaction(async (tx) => {
    await tx.notificationRead.deleteMany();
    await tx.mention.deleteMany();
    await tx.contentReaction.deleteMany();
    await tx.contentViewEvent.deleteMany();
    await tx.contentMetric.deleteMany();
    await tx.reply.deleteMany();
    await tx.comment.deleteMany();
    await tx.galleryTag.deleteMany();
    await tx.newsAttachment.deleteMany();
    await tx.projectPatch.deleteMany();
    await tx.chatReadState.deleteMany();
    await tx.chatMessage.deleteMany();
    await tx.chatConversationMember.deleteMany();
    await tx.chatConversation.deleteMany();
    await tx.refreshToken.deleteMany();
    await tx.securitySession.deleteMany();
    await (tx as any).passwordResetRequest.deleteMany();
    await tx.extractionJob.deleteMany();
    await tx.auditLog.deleteMany({ where: { action: { not: 'migration.job' } } });
    await tx.securityEvent.deleteMany();
    await tx.securityBlock.deleteMany();
    await tx.securityPolicy.deleteMany();
    await tx.fileScanRecord.deleteMany();
    await tx.personnelReport.deleteMany();
    await tx.managementRequest.deleteMany();
    await tx.team.deleteMany();
    await tx.quotaRecord.deleteMany();
    await tx.notification.deleteMany();
    await tx.mapMarker.deleteMany();
    await tx.mapImage.deleteMany();
    await tx.galleryItem.deleteMany();
    await tx.entityDoc.deleteMany();
    await tx.loreItem.deleteMany();
    await tx.news.deleteMany();
    await tx.project.deleteMany();
    await tx.commandCenterSettings.deleteMany();
    await tx.user.deleteMany();

    if (dataset.users.length) await tx.user.createMany({ data: dataset.users as any });
    if (dataset.securitySessions.length) await tx.securitySession.createMany({ data: dataset.securitySessions as any });
    if (dataset.passwordResetRequests.length) await (tx as any).passwordResetRequest.createMany({ data: dataset.passwordResetRequests as any });
    if (dataset.commandCenterSettings.length) await tx.commandCenterSettings.createMany({ data: dataset.commandCenterSettings as any });
    if (dataset.refreshTokens.length) await tx.refreshToken.createMany({ data: dataset.refreshTokens as any });
    if (dataset.projects.length) await tx.project.createMany({ data: dataset.projects as any });
    if (dataset.projectPatches.length) await tx.projectPatch.createMany({ data: dataset.projectPatches as any });
    if (dataset.news.length) await tx.news.createMany({ data: dataset.news as any });
    if (dataset.newsAttachments.length) await tx.newsAttachment.createMany({ data: dataset.newsAttachments as any });
    if (dataset.loreItems.length) await tx.loreItem.createMany({ data: dataset.loreItems as any });
    if (dataset.entityDocs.length) await tx.entityDoc.createMany({ data: dataset.entityDocs as any });
    if (dataset.galleryItems.length) await tx.galleryItem.createMany({ data: dataset.galleryItems as any });
    if (dataset.galleryTags.length) await tx.galleryTag.createMany({ data: dataset.galleryTags as any });
    if (dataset.mapImages.length) await tx.mapImage.createMany({ data: dataset.mapImages as any });
    if (dataset.mapMarkers.length) await tx.mapMarker.createMany({ data: dataset.mapMarkers as any });
    if (dataset.comments.length) await tx.comment.createMany({ data: dataset.comments as any });
    if (dataset.replies.length) await tx.reply.createMany({ data: dataset.replies as any });
    if (dataset.mentions.length) await tx.mention.createMany({ data: dataset.mentions as any });
    if (dataset.contentMetrics.length) await tx.contentMetric.createMany({ data: dataset.contentMetrics as any });
    if (dataset.contentViewEvents.length) await tx.contentViewEvent.createMany({ data: dataset.contentViewEvents as any });
    if (dataset.contentReactions.length) await tx.contentReaction.createMany({ data: dataset.contentReactions as any });
    if (dataset.managementRequests.length) await tx.managementRequest.createMany({ data: dataset.managementRequests as any });
    if (dataset.teams.length) await tx.team.createMany({ data: dataset.teams as any });
    if (dataset.quotaRecords.length) await tx.quotaRecord.createMany({ data: dataset.quotaRecords as any });
    if (dataset.notifications.length) await tx.notification.createMany({ data: dataset.notifications as any });
    if (dataset.notificationReads.length) await tx.notificationRead.createMany({ data: dataset.notificationReads as any });
    if (dataset.chatConversations.length) await tx.chatConversation.createMany({ data: dataset.chatConversations as any });
    if (dataset.chatConversationMembers.length) await tx.chatConversationMember.createMany({ data: dataset.chatConversationMembers as any });
    if (dataset.chatMessages.length) await tx.chatMessage.createMany({ data: dataset.chatMessages as any });
    if (dataset.chatReadStates.length) await tx.chatReadState.createMany({ data: dataset.chatReadStates as any });
    if (dataset.extractionJobs.length) await tx.extractionJob.createMany({ data: dataset.extractionJobs as any });
    if (dataset.auditLogs.length) await tx.auditLog.createMany({ data: dataset.auditLogs as any });
    if (dataset.securityEvents.length) await tx.securityEvent.createMany({ data: dataset.securityEvents as any });
    if (dataset.securityBlocks.length) await tx.securityBlock.createMany({ data: dataset.securityBlocks as any });
    if (dataset.securityPolicies.length) await tx.securityPolicy.createMany({ data: dataset.securityPolicies as any });
    if (dataset.fileScanRecords.length) await tx.fileScanRecord.createMany({ data: dataset.fileScanRecords as any });
    if (dataset.personnelReports.length) await tx.personnelReport.createMany({ data: dataset.personnelReports as any });
  });
};

const pullMigrationAssets = async (payload: MigrationPayload, migrationKey: string): Promise<MigrationVerification> => {
  let uploadedAssetCount = 0;
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  for (const asset of payload.assets) {
    try {
      const url = `${payload.source.assetEndpoint}?path=${encodeURIComponent(asset.objectPath)}`;
      const response = await fetch(url, {
        headers: {
          'x-migration-key': migrationKey
        }
      });
      if (!response.ok) {
        throw new Error(`Source asset responded with ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      await saveFileToStorage({
        objectPath: asset.objectPath,
        buffer: Buffer.from(arrayBuffer),
        contentType
      });
      uploadedAssetCount += 1;
    } catch (error) {
      failedAssets.push({
        objectPath: asset.objectPath,
        error: error instanceof Error ? error.message : 'Unknown asset transfer failure'
      });
    }
  }

  const counts = await countCurrentMigrationState();
  return {
    tables: counts.tables,
    assetCount: counts.assetCount,
    uploadedAssetCount,
    failedAssets
  };
};

const serializeMigrationJob = (log: Awaited<ReturnType<typeof prisma.auditLog.findFirst>>) => {
  if (!log) return log;
  const metadata = (log.metadata ?? {}) as Record<string, unknown>;
  return {
    id: log.id,
    status: String(metadata.status ?? 'processing'),
    targetUrl: String(metadata.targetUrl ?? ''),
    createdAt: log.createdAt.toISOString(),
    completedAt: typeof metadata.completedAt === 'string' ? metadata.completedAt : undefined,
    downloadName: typeof metadata.downloadName === 'string' ? metadata.downloadName : undefined,
    artifactPath: typeof metadata.artifactPath === 'string' ? metadata.artifactPath : undefined,
    progress: metadata.progress ?? migrationProgress(0, 'queued', 'Queued'),
    error: typeof metadata.error === 'string' ? metadata.error : undefined,
    summary: metadata.summary ?? undefined,
    verification: metadata.verification ?? undefined
  };
};

const runMigrationJob = async (
  jobId: string,
  actor: string,
  targetUrl: string,
  sourceAssetEndpoint: string,
  migrationKey: string,
  downloadName: string
) => {
  const updateMetadata = async (patch: Record<string, unknown>) => {
    const current = await prisma.auditLog.findUnique({ where: { id: jobId } });
    const currentMetadata = (current?.metadata ?? {}) as Record<string, unknown>;
    const updated = await prisma.auditLog.update({
      where: { id: jobId },
      data: {
        metadata: {
          ...currentMetadata,
          ...patch
        } as Prisma.InputJsonValue
      }
    });
    emitToUser(actor, 'settings.migration.updated', { job: serializeMigrationJob(updated) as Record<string, unknown> });
  };

  try {
    await updateMetadata({ progress: migrationProgress(10, 'collecting', 'Collecting migration payload') });
    const payload = await collectMigrationPayload(sourceAssetEndpoint);
    await updateMetadata({
      summary: payload.summary,
      progress: migrationProgress(35, 'sending', 'Sending payload to target backend')
    });

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-migration-key': migrationKey
      },
      body: Buffer.from(JSON.stringify(payload), 'utf8')
    });

    if (!response.ok) {
      throw new Error(`Target backend rejected migration with status ${response.status}`);
    }

    await updateMetadata({ progress: migrationProgress(80, 'verifying', 'Comparing target verification results') });
    const responsePayload = (await response.json()) as { success?: boolean; data?: MigrationVerification; message?: string };
    if (!responsePayload.success || !responsePayload.data) {
      throw new Error(responsePayload.message || 'Target backend returned an invalid migration response');
    }

    const verification = responsePayload.data;
    const comparison = {
      tablesMatch: Object.entries(payload.summary.tables).every(
        ([key, value]) => Number(verification.tables[key] ?? 0) === value
      ),
      assetsMatch: verification.assetCount === payload.summary.assetCount,
      uploadedAssetsMatch: verification.uploadedAssetCount === payload.summary.assetCount
    };

    const report = {
      exportedAt: payload.exportedAt,
      actor,
      targetUrl,
      payloadSummary: payload.summary,
      verification,
      comparison
    };

    const stored = await saveFileToStorage({
      objectPath: `exports/migrations/${jobId}/${downloadName}`,
      buffer: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      contentType: 'application/json'
    });

    await updateMetadata({
      status: 'completed',
      completedAt: new Date().toISOString(),
      artifactPath: stored.objectPath,
      artifactUrl: stored.url,
      downloadName,
      verification,
      comparison,
      progress: migrationProgress(100, 'completed', 'Migration verification report ready')
    });
  } catch (error) {
    await updateMetadata({
      status: 'failed',
      error: error instanceof Error ? error.message : 'Migration failed',
      progress: migrationProgress(100, 'failed', 'Migration failed')
    });
  }
};

const buildDefaultMigrationReceiveUrl = (baseUrl: string) => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/api$/i.test(trimmed) ? `${trimmed}/settings/migration/receive` : `${trimmed}/api/settings/migration/receive`;
};

const sendExtractionDownload = async (
  res: Response,
  job: { id: string; artifactPath: string | null; downloadName: string | null },
  actor: string
) => {
  if (!job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');

  await writeAudit(prisma, {
    actor,
    action: 'extraction.download',
    entity: 'ExtractionJob',
    entityId: job.id
  });

  const file = await createReadStreamFromStorage(job.artifactPath);
  const filename = job.downloadName ?? `morneven-backup-${job.id}.zip`;
  res.setHeader('Content-Type', file.contentType ?? 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (file.contentLength !== undefined) res.setHeader('Content-Length', String(file.contentLength));

  file.stream.on('error', (error) => {
    if (!res.headersSent) {
      fail(res, 500, 'Download stream failed', 'STORAGE_ERROR');
      return;
    }
    res.destroy(error);
  });
  return file.stream.pipe(res);
};

settingsRouter.get('/migration/assets', async (req, res) => {
  try {
    requireMigrationKey(req.header('x-migration-key'));
    const objectPath = extractStorageObjectPath(String(req.query.path ?? ''));
    if (!objectPath) return fail(res, 422, 'Invalid object path', 'VALIDATION_ERROR');
    const stored = await readFileWithMetadataFromStorage(objectPath);
    res.setHeader('Content-Type', stored.contentType ?? 'application/octet-stream');
    return res.send(stored.buffer);
  } catch (error) {
    return fail(res, 403, error instanceof Error ? error.message : 'Forbidden', 'FORBIDDEN');
  }
});

settingsRouter.post('/migration/receive', raw({ type: 'application/octet-stream', limit: '250mb' }), async (req, res) => {
  try {
    const migrationKey = req.header('x-migration-key');
    requireMigrationKey(migrationKey);
    if (!Buffer.isBuffer(req.body)) return fail(res, 422, 'Migration payload is required', 'VALIDATION_ERROR');
    const payload = parseMigrationPayload(req.body);
    await importMigrationDataset(payload.dataset);
    const verification = await pullMigrationAssets(payload, migrationKey!);
    return ok(res, verification);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Migration receive failed', 'MIGRATION_ERROR');
  }
});

settingsRouter.get('/extractions', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const jobs = await prisma.extractionJob.findMany({
    where: { createdBy: req.user!.username, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
  return ok(res, jobs.map(serializeExtractionJob));
});

settingsRouter.post('/extractions', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;

  const parsed = extractionSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid extraction key';
    return fail(
      res,
      message.includes('configured') ? 503 : 403,
      message,
      message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN'
    );
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordOk) return fail(res, 403, 'Password confirmation failed', 'FORBIDDEN');

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const downloadName = `morneven-backup-${parsed.data.mode}-${createdAt.toISOString().slice(0, 10)}.zip`;
  const job = await prisma.extractionJob.create({
    data: {
      mode: parsed.data.mode,
      autoDownload: parsed.data.autoDownload,
      status: 'processing',
      createdBy: req.user!.username,
      expiresAt,
      downloadName,
      progress: extractionProgress(0, 'queued', 'Queued')
    }
  });

  setImmediate(() => {
    void runExtractionJob(job.id, parsed.data.mode, parsed.data.mediaSources, req.user!.username, downloadName);
  });

  emitToUser(req.user!.username, 'settings.extraction.updated', { job: serializeExtractionJob(job) as Record<string, unknown> });
  return res.status(202).json({ success: true, data: serializeExtractionJob(job) });
});

settingsRouter.get('/extractions/:id', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const job = await prisma.extractionJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job) return fail(res, 404, 'Extraction job not found', 'NOT_FOUND');
  return ok(res, serializeExtractionJob(job));
});

settingsRouter.post('/extractions/:id/download-ticket', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const parsed = extractionDownloadTicketSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid extraction key';
    return fail(
      res,
      message.includes('configured') ? 503 : 403,
      message,
      message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN'
    );
  }

  const job = await prisma.extractionJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
  const ticket = createExtractionDownloadTicket(job.id, req.user!.username);
  return ok(res, {
    ticket,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  });
});

settingsRouter.get('/extractions/:id/download', async (req, res, next: NextFunction) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
  if (!ticket) return next();

  try {
    const payload = parseExtractionDownloadTicket(ticket);
    if (payload.jobId !== req.params.id) return fail(res, 403, 'Invalid download ticket', 'FORBIDDEN');
    const job = await prisma.extractionJob.findFirst({ where: { id: payload.jobId, createdBy: payload.actor } });
    if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
    return sendExtractionDownload(res, job, payload.actor);
  } catch (error) {
    return fail(res, 403, error instanceof Error ? error.message : 'Invalid download ticket', 'FORBIDDEN');
  }
});

settingsRouter.get('/extractions/:id/download', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const job = await prisma.extractionJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
  return sendExtractionDownload(res, job, req.user!.username);
});

settingsRouter.get('/migrations', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const jobs = await prisma.auditLog.findMany({
    where: {
      actor: req.user!.username,
      action: 'migration.job'
    },
    orderBy: { createdAt: 'desc' }
  });
  return ok(res, jobs.map(serializeMigrationJob));
});

settingsRouter.post('/migrations', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const parsed = migrationSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  if (!env.migrationKey) return fail(res, 503, 'Migration key is not configured', 'MIGRATION_UNAVAILABLE');

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordOk) return fail(res, 403, 'Password confirmation failed', 'FORBIDDEN');
  if (parsed.data.secretKey !== env.migrationKey) return fail(res, 403, 'Migration secret key is invalid', 'FORBIDDEN');

  const targetUrl = parsed.data.migrationUrl || buildDefaultMigrationReceiveUrl(parsed.data.newBaseUrl || '');
  const createdAt = new Date();
  const downloadName = `morneven-migration-report-${createdAt.toISOString().slice(0, 10)}.json`;
  const job = await prisma.auditLog.create({
    data: {
      actor: req.user!.username,
      action: 'migration.job',
      entity: 'MigrationJob',
      metadata: {
        status: 'processing',
        targetUrl,
        downloadName,
        progress: migrationProgress(0, 'queued', 'Queued')
      }
    }
  });

  const sourceAssetEndpoint = `${req.protocol}://${req.get('host')}/api/settings/migration/assets`;
  setImmediate(() => {
    void runMigrationJob(job.id, req.user!.username, targetUrl, sourceAssetEndpoint, parsed.data.secretKey, downloadName);
  });

  emitToUser(req.user!.username, 'settings.migration.updated', { job: serializeMigrationJob(job) as Record<string, unknown> });
  return res.status(202).json({ success: true, data: serializeMigrationJob(job) });
});

settingsRouter.get('/migrations/:id', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const job = await prisma.auditLog.findFirst({
    where: {
      id: req.params.id,
      actor: req.user!.username,
      action: 'migration.job'
    }
  });
  if (!job) return fail(res, 404, 'Migration job not found', 'NOT_FOUND');
  return ok(res, serializeMigrationJob(job));
});

settingsRouter.get('/migrations/:id/download', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const job = await prisma.auditLog.findFirst({
    where: {
      id: req.params.id,
      actor: req.user!.username,
      action: 'migration.job'
    }
  });
  if (!job) return fail(res, 404, 'Migration job not found', 'NOT_FOUND');
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.artifactPath !== 'string') return fail(res, 404, 'Migration report not found', 'NOT_FOUND');

  const file = await readFileFromStorage(metadata.artifactPath);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${String(metadata.downloadName ?? `morneven-migration-report-${job.id}.json`)}"`);
  return res.send(file);
});

settingsRouter.get('/storage-cleanup', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const report = await getStorageCleanupReport();
  return ok(res, report);
});

settingsRouter.post('/storage-cleanup', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const report = await runStorageCleanup();
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'storage.cleanup.run',
    entity: 'Storage',
    metadata: {
      orphanedObjects: report.orphanedObjects,
      deletedObjects: report.deletedObjects,
      deletedBytes: report.deletedBytes
    }
  });
  return ok(res, report);
});

settingsRouter.delete('/extractions', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const parsed = clearExtractionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const where = parsed.data.ids?.length
    ? { createdBy: req.user!.username, id: { in: parsed.data.ids } }
    : { createdBy: req.user!.username };
  const jobs = await prisma.extractionJob.findMany({ where, select: { artifactPath: true, artifactUrl: true } });
  const result = await prisma.extractionJob.deleteMany({ where });
  await cleanupUnreferencedStoragePaths(
    jobs.flatMap((job) => [job.artifactPath, job.artifactUrl])
  );
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'extraction.delete',
    entity: 'ExtractionJob',
    metadata: { count: result.count }
  });
  emitToUser(req.user!.username, 'settings.extractions.updated', { deleted: result.count });
  return ok(res, { deleted: result.count });
});
