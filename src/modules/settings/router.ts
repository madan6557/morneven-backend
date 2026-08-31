import { NextFunction, Request, Response, Router } from 'express';
import { raw } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { EntityType, Prisma, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth, hasPl7MaintenanceAccess, isPl7Author } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { deleteFileFromStorage, listStorageObjects, saveFileToStorage } from '../../config/storage.js';
import { readFileFromStorage } from '../../config/storage.js';
import { readFileWithMetadataFromStorage } from '../../config/storage.js';
import { createReadStreamFromStorage } from '../../config/storage.js';
import { fail, ok } from '../../utils/response.js';
import {
  buildDatabaseSqlDump,
  collectExtractionSnapshot,
  collectMigrationDataset,
  collectMigrationPayload,
  countCurrentMigrationState,
  importMigrationDataset,
  prepareMigrationDatasetForRestore,
  summarizeMigrationDataset,
  type ExportSnapshot,
  type MigrationDataset,
  type MigrationPayload,
  type MigrationVerification
} from '../../utils/data-contract.js';
import { makeZip, readZip, ZipFile } from '../../utils/zip.js';
import { writeAudit } from '../../utils/audit.js';
import { defaultCommandCenterSettings, ensureActiveCommandCenterPreset } from './preset-service.js';
import {
  cleanupUnreferencedStoragePaths,
  extractStorageObjectPath,
  getStorageCleanupReport,
  runStorageCleanup
} from '../../utils/storage-cleanup.js';
import { emitToUser } from '../../realtime/events.js';
import { isReadableObjectPath, normalizeObjectPath } from '../files/object-path.js';
import { inspectUploadBuffer } from '../../security/files/scanner.js';
import {
  deleteScheduledTask,
  registerScheduledTaskHandler,
  scheduleInputSchema,
  serializeScheduledTask,
  upsertScheduledTask
} from '../../scheduler/index.js';

export const settingsRouter = Router();

const defaultSettings = defaultCommandCenterSettings;
const MIGRATION_BACKUP_UPLOAD_LIMIT_MB = 500;
const migrationBackupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MIGRATION_BACKUP_UPLOAD_LIMIT_MB * 1024 * 1024 }
});
const migrationBackupUploadSingle = (req: Request, res: Response, next: NextFunction) => {
  migrationBackupUpload.single('backup')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      fail(res, 413, `Backup archive exceeds ${MIGRATION_BACKUP_UPLOAD_LIMIT_MB} MB limit`, 'UPLOAD_TOO_LARGE');
      return;
    }

    fail(res, 400, error instanceof Error ? error.message : 'Backup upload failed', 'UPLOAD_ERROR');
  });
};

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
  'map',
  'bot-manager'
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
  'map',
  'bot-manager'
];

const extractionSchema = z.object({
  mode: z.enum(['db', 'images', 'all']),
  mediaSources: z.array(backupMediaSourceSchema).optional().default(defaultBackupMediaSources),
  autoDownload: z.boolean().optional().default(false),
  confirmText: z.literal('CONFIRM'),
  password: z.string().min(1),
  secretKey: z.string().min(16)
});

const extractionRetrySchema = z.object({
  mediaSources: z.array(backupMediaSourceSchema).optional().default(defaultBackupMediaSources),
  autoDownload: z.boolean().optional(),
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

const backupMigrationSchema = z.object({
  confirmText: z.literal('MIGRATION'),
  password: z.string().min(1),
  secretKey: z.string().min(16),
  allowBlockedFiles: z.string().optional()
});

const clearExtractionSchema = z.object({
  ids: z.array(z.string()).optional()
});

const extractionDownloadTicketSchema = z.object({
  secretKey: z.string().min(16)
});

const extractionScheduleSchema = scheduleInputSchema.extend({
  mode: z.enum(['db', 'images', 'all']).default('all'),
  mediaSources: z.array(backupMediaSourceSchema).optional().default(defaultBackupMediaSources),
  retentionCount: z.coerce.number().int().min(1).max(10).default(3),
  retentionDays: z.coerce.number().int().min(1).max(30).default(7),
  password: z.string().min(1),
  secretKey: z.string().min(16)
});

const extractionScheduleDeleteSchema = z.object({
  password: z.string().min(1),
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

const isGeneratedBackupArtifactPath = (objectPath: string) => {
  const normalized = objectPath.toLowerCase().replace(/^\/+/, '');
  return normalized.startsWith('backups/') || normalized.startsWith('bot-manager/backups/');
};

const shouldEmbedBackupMediaObject = (objectPath: string) =>
  !isGeneratedBackupArtifactPath(objectPath);

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
    botManagerIdentities,
    botManagerFiles,
    loreItems,
    docs,
    storageObjects
  ] = await Promise.all([
    prisma.chatMessage.findMany({ select: { attachments: true } }),
    prisma.galleryItem.findMany({ include: { tags: true } }),
    prisma.project.findMany(),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.mapImage.findUnique({ where: { id: 'main' } }),
    prisma.botManagerIdentity.findMany(),
    prisma.botManagerIdentityFile.findMany(),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany(),
    listStorageObjects()
  ]);

  for (const message of chatMessages) addPathSetValue(sets.chat, message.attachments);
  for (const item of galleryItems) addPathSetValue(sets.gallery, item);
  for (const project of projects) addPathSetValue(sets.projects, project);
  for (const item of news) addPathSetValue(sets.news, item);
  addPathSetValue(sets.map, mapImage?.imageUrl);
  for (const identity of botManagerIdentities) addPathSetValue(sets['bot-manager'], identity);
  for (const file of botManagerFiles) {
    if (shouldEmbedBackupMediaObject(file.objectPath)) addPathSetValue(sets['bot-manager'], file.objectPath);
  }
  for (const object of storageObjects) {
    if (object.objectPath.startsWith('bot-manager/') && shouldEmbedBackupMediaObject(object.objectPath)) {
      sets['bot-manager'].add(object.objectPath);
    }
  }

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
    const dataset = prepareMigrationDatasetForRestore(await collectMigrationDataset());
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
    files.push({ name: 'db/site-visit-events.json', content: JSON.stringify(exportedSnapshot.siteVisitEvents, null, 2) });
    files.push({ name: 'db/content-reactions.json', content: JSON.stringify(exportedSnapshot.contentReactions, null, 2) });
    files.push({ name: 'db/map.json', content: JSON.stringify(exportedSnapshot.map, null, 2) });
    files.push({ name: 'db/bot-manager.json', content: JSON.stringify(exportedSnapshot.botManager, null, 2) });
    files.push({
      name: 'zeroclaw/runtime-bundle.json',
      content: JSON.stringify({
        format: 'morneven-zeroclaw-runtime-backup/v1',
        generatedAt: new Date().toISOString(),
        restoreState: 'disabled',
        generalConfig: snapshot.botManager.generalConfig,
        identities: snapshot.botManager.identities,
        files: snapshot.botManager.files,
        encryptedProviderAccounts: snapshot.botManager.providerAccounts,
        encryptedCredentials: snapshot.botManager.credentials,
        encryptedOpenRouterProfiles: snapshot.botManager.openRouterProfiles,
        encryptedAnalyticsCredentials: snapshot.botManager.analyticsCredentials
      }, null, 2)
    });

    const [scheduledTasks, runtimeControlState] = await Promise.all([
      prisma.scheduledTask.findMany({
        select: {
          key: true,
          kind: true,
          targetId: true,
          timezone: true,
          schedule: true,
          payload: true,
          createdBy: true,
          updatedBy: true
        },
        orderBy: { key: 'asc' }
      }),
      prisma.runtimeControlState.findUnique({ where: { id: 'global' } })
    ]);
    files.push({
      name: 'schedules/definitions.json',
      content: JSON.stringify({
        format: 'morneven-schedules/v1',
        restoreState: 'disabled',
        tasks: scheduledTasks
      }, null, 2)
    });
    files.push({
      name: 'zeroclaw/runtime-control-state.json',
      content: JSON.stringify({
        format: 'morneven-runtime-control-state/v1',
        restoreState: 'stopped',
        previousState: runtimeControlState
      }, null, 2)
    });
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

  const manifestFiles = files.map((file) => {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    return {
      path: file.name,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex')
    };
  });
  files.unshift({
    name: 'manifest.json',
    content: JSON.stringify({
      format: 'morneven-zeroclaw-backup/v1',
      generatedAt: new Date().toISOString(),
      mode,
      files: manifestFiles
    }, null, 2)
  });

  return {
    files,
    mediaSummary: {
      embeddedCount: embeddedAssets.size,
      failedCount: failedAssets.length,
      selectedSources
    }
  };
};

const EXTRACTION_STALE_MS = 30 * 60 * 1000;
const EXTRACTION_LEASE_MS = 35 * 60 * 1000;
const EXTRACTION_WORKER_POLL_MS = 5 * 1000;
const STORAGE_CLEANUP_THRESHOLD_BYTES = 350 * 1024 * 1024;
const STORAGE_BLOCK_THRESHOLD_BYTES = 450 * 1024 * 1024;
const extractionWorkerId = `extraction-${process.pid}-${randomUUID()}`;
let extractionWorkerTimer: NodeJS.Timeout | null = null;
let extractionWorkerTicking = false;
const extractionProgress = (percent: number, stage: string, message: string) => ({
  percent,
  stage,
  message,
  updatedAt: new Date().toISOString()
});

const formatBackupDownloadName = (date: Date) => {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const bb = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `backup_${dd}${bb}${yy}${hh}${mm}${ss}.zip`;
};

const serializeExtractionJob = (job: Awaited<ReturnType<typeof prisma.extractionJob.findFirst>> | Awaited<ReturnType<typeof prisma.extractionJob.create>>) => {
  if (!job) return job;
  return {
    ...job,
    progress: job.progress ?? extractionProgress(0, 'queued', 'Queued')
  };
};

type ExtractionJobRecord = NonNullable<Awaited<ReturnType<typeof prisma.extractionJob.findFirst>>>;

const extractionProgressRecord = (progress: Prisma.JsonValue | null | undefined) => {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
  return progress as Record<string, unknown>;
};

const extractionProgressPercent = (job: ExtractionJobRecord) => {
  const percent = extractionProgressRecord(job.progress).percent;
  return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
};

const extractionHeartbeatTime = (job: ExtractionJobRecord) => {
  const updatedAt = extractionProgressRecord(job.progress).updatedAt;
  const parsed = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : job.createdAt.getTime();
};

const removeExtractionArtifact = async (job: Pick<ExtractionJobRecord, 'artifactPath'>) => {
  if (!job.artifactPath) return;
  await deleteFileFromStorage(job.artifactPath).catch(() => undefined);
};

const stopExtractionJob = async (job: ExtractionJobRecord, actor: string, reason: string) => {
  const progress = extractionProgress(
    extractionProgressPercent(job),
    'stopped',
    reason
  );
  const result = await prisma.extractionJob.updateMany({
    where: { id: job.id, status: { in: ['queued', 'processing'] } },
    data: {
      status: 'stopped',
      completedAt: new Date(),
      error: reason,
      progress,
      leaseOwner: null,
      leaseUntil: null,
      artifactPath: null,
      artifactUrl: null
    }
  });
  if (!result.count) return null;
  await removeExtractionArtifact(job);
  const stopped = await prisma.extractionJob.findUnique({ where: { id: job.id } });
  if (stopped) emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(stopped) as Record<string, unknown> });
  return stopped;
};

const stopStaleExtractionJobs = async (actor?: string) => {
  const now = Date.now();
  const jobs = await prisma.extractionJob.findMany({
    where: {
      ...(actor ? { createdBy: actor } : {}),
      status: 'processing',
      expiresAt: { gt: new Date() }
    }
  });
  for (const job of jobs) {
    if (extractionProgressPercent(job) >= 100) continue;
    if (now - extractionHeartbeatTime(job) <= EXTRACTION_STALE_MS) continue;
    await stopExtractionJob(job, job.createdBy, 'Backup job stopped because progress did not update for 30 minutes. Retry to start again from 0%.');
  }
};

const stopExpiredExtractionJobs = async (actor?: string) => {
  const jobs = await prisma.extractionJob.findMany({
    where: {
      ...(actor ? { createdBy: actor } : {}),
      status: { in: ['queued', 'processing'] },
      expiresAt: { lte: new Date() }
    }
  });
  for (const job of jobs) {
    await stopExtractionJob(
      job,
      job.createdBy,
      'Backup job stopped because it expired before completion. Retry to start again from 0%.'
    );
  }
};

const totalStorageBytes = async () => {
  const objects = await listStorageObjects();
  return objects.reduce((total, object) => total + (object.size ?? 0), 0);
};

const pruneExtractionBackups = async (retentionCount: number, retentionDays: number) => {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const jobs = await prisma.extractionJob.findMany({
    where: { status: { in: ['completed', 'failed', 'stopped'] } },
    orderBy: { createdAt: 'desc' }
  });
  let retainedArtifactCount = 0;
  const removable = jobs.filter((job) => {
    if (job.createdAt < cutoff) return true;
    if (job.status !== 'completed' || !job.artifactPath) return false;
    retainedArtifactCount += 1;
    return retainedArtifactCount > retentionCount;
  });
  for (const job of removable) {
    await removeExtractionArtifact(job);
  }
  if (removable.length) {
    await prisma.extractionJob.deleteMany({ where: { id: { in: removable.map((job) => job.id) } } });
  }
  return removable.length;
};

const enforceExtractionStorageLimit = async (
  retentionCount: number,
  retentionDays: number,
  additionalBytes = 0
) => {
  await pruneExtractionBackups(retentionCount, retentionDays);
  let usage = await totalStorageBytes();
  if (usage >= STORAGE_CLEANUP_THRESHOLD_BYTES) {
    await runStorageCleanup();
    await pruneExtractionBackups(retentionCount, retentionDays);
    usage = await totalStorageBytes();
  }
  if (usage + additionalBytes >= STORAGE_BLOCK_THRESHOLD_BYTES) {
    throw new Error('Backup blocked because storage usage remains at or above 450 MiB after cleanup');
  }
  return usage;
};

const extractionRequestRecord = (job: ExtractionJobRecord) => {
  if (!job.request || typeof job.request !== 'object' || Array.isArray(job.request)) return {};
  return job.request as Record<string, unknown>;
};

const runExtractionJob = async (
  job: ExtractionJobRecord,
  mode: 'db' | 'images' | 'all',
  mediaSources: BackupMediaSource[],
  retentionCount: number,
  retentionDays: number
) => {
  const jobId = job.id;
  const actor = job.createdBy;
  const downloadName = job.downloadName ?? formatBackupDownloadName(job.createdAt);
  let objectPath: string | null = null;
  try {
    const updateProgress = async (percent: number, stage: string, message: string) => {
      const result = await prisma.extractionJob.updateMany({
        where: { id: jobId, status: 'processing', leaseOwner: extractionWorkerId },
        data: {
          progress: extractionProgress(percent, stage, message),
          leaseUntil: new Date(Date.now() + EXTRACTION_LEASE_MS)
        }
      });
      if (!result.count) throw new Error('Extraction job stopped');
      const updated = await prisma.extractionJob.findUnique({ where: { id: jobId } });
      if (!updated) throw new Error('Extraction job not found');
      emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(updated) as Record<string, unknown> });
    };

    await enforceExtractionStorageLimit(retentionCount, retentionDays);
    await updateProgress(10, 'collecting', 'Collecting backup data');
    const { files, mediaSummary } = await buildExtractionFiles(mode, mediaSources, updateProgress);

    await updateProgress(70, 'compressing', 'Compressing backup archive');
    const zip = makeZip(files);

    await updateProgress(85, 'uploading', 'Uploading backup artifact');
    await enforceExtractionStorageLimit(retentionCount, retentionDays, zip.length);
    objectPath = `backups/${jobId}/${downloadName}`;
    const stored = await saveFileToStorage({ objectPath, buffer: zip, contentType: 'application/zip' });

    const result = await prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'processing', leaseOwner: extractionWorkerId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        artifactPath: stored.objectPath,
        artifactUrl: stored.url,
        progress: extractionProgress(100, 'completed', 'Backup ready'),
        leaseOwner: null,
        leaseUntil: null
      }
    });
    if (!result.count) {
      await deleteFileFromStorage(stored.objectPath).catch(() => undefined);
      return;
    }
    const completed = await prisma.extractionJob.findUnique({ where: { id: jobId } });
    if (!completed) return;
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
    await pruneExtractionBackups(retentionCount, retentionDays);
  } catch (error) {
    if (objectPath) await deleteFileFromStorage(objectPath).catch(() => undefined);
    const current = await prisma.extractionJob.findUnique({ where: { id: jobId } });
    if (!current || current.status === 'stopped') return;
    const message = error instanceof Error ? error.message : 'Backup failed';
    const result = await prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'processing', leaseOwner: extractionWorkerId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        error: message,
        progress: extractionProgress(extractionProgressPercent(current), 'failed', message),
        leaseOwner: null,
        leaseUntil: null,
        artifactPath: null,
        artifactUrl: null
      }
    });
    if (!result.count) return;
    const failed = await prisma.extractionJob.findUnique({ where: { id: jobId } });
    if (!failed) return;
    emitToUser(actor, 'settings.extraction.updated', { job: serializeExtractionJob(failed) as Record<string, unknown> });
  }
};

const createExtractionJob = async (input: {
  mode: 'db' | 'images' | 'all';
  mediaSources: BackupMediaSource[];
  autoDownload: boolean;
  actor: string;
  idempotencyKey: string;
  source?: 'manual' | 'scheduled' | 'retry';
  parentJobId?: string;
  attempt?: number;
  retentionCount?: number;
  retentionDays?: number;
}) => {
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(idempotencyKey)
  ) {
    throw new Error('Invalid extraction idempotency key');
  }
  await stopExpiredExtractionJobs(input.actor);
  const createdAt = new Date();
  const retentionCount = input.retentionCount ?? 3;
  const retentionDays = input.retentionDays ?? 7;
  const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const downloadName = formatBackupDownloadName(createdAt);
  const existing = await prisma.extractionJob.findUnique({
    where: {
      createdBy_idempotencyKey: {
        createdBy: input.actor,
        idempotencyKey
      }
    }
  });
  if (existing) return existing;
  const active = await prisma.extractionJob.findFirst({
    where: {
      createdBy: input.actor,
      status: { in: ['queued', 'processing'] },
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (active) return active;

  let job: ExtractionJobRecord;
  try {
    job = await prisma.extractionJob.create({
      data: {
        mode: input.mode,
        autoDownload: input.autoDownload,
        status: 'queued',
        source: input.source ?? 'manual',
        request: {
          mediaSources: input.mediaSources,
          retentionCount,
          retentionDays
        },
        idempotencyKey,
        parentJobId: input.parentJobId,
        attempt: input.attempt ?? 1,
        createdBy: input.actor,
        expiresAt,
        downloadName,
        progress: extractionProgress(0, 'queued', 'Queued')
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const duplicate = await prisma.extractionJob.findUnique({
        where: {
          createdBy_idempotencyKey: {
            createdBy: input.actor,
            idempotencyKey
          }
        }
      });
      if (duplicate) return duplicate;
      const activeDuplicate = await prisma.extractionJob.findFirst({
        where: {
          createdBy: input.actor,
          status: { in: ['queued', 'processing'] },
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' }
      });
      if (activeDuplicate) return activeDuplicate;
    }
    throw error;
  }

  emitToUser(input.actor, 'settings.extraction.updated', { job: serializeExtractionJob(job) as Record<string, unknown> });
  void runExtractionWorkerTick().catch((error) => {
    console.error('Extraction worker tick failed after job creation', error);
  });
  return job;
};

const claimQueuedExtractionJob = async () => {
  const candidate = await prisma.extractionJob.findFirst({
    where: {
      status: 'queued',
      expiresAt: { gt: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
    },
    orderBy: { createdAt: 'asc' }
  });
  if (!candidate) return null;
  const claimed = await prisma.extractionJob.updateMany({
    where: {
      id: candidate.id,
      status: 'queued',
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
    },
    data: {
      status: 'processing',
      leaseOwner: extractionWorkerId,
      leaseUntil: new Date(Date.now() + EXTRACTION_LEASE_MS),
      progress: extractionProgress(0, 'starting', 'Starting backup')
    }
  });
  if (!claimed.count) return null;
  return prisma.extractionJob.findUnique({ where: { id: candidate.id } });
};

export const runExtractionWorkerTick = async () => {
  if (extractionWorkerTicking) return;
  extractionWorkerTicking = true;
  try {
    await stopExpiredExtractionJobs();
    await stopStaleExtractionJobs();
    for (;;) {
      const job = await claimQueuedExtractionJob();
      if (!job) break;
      try {
        const request = extractionRequestRecord(job);
        const mediaSources = z.array(backupMediaSourceSchema).safeParse(request.mediaSources);
        const mode = z.enum(['db', 'images', 'all']).parse(job.mode);
        const retentionCount = z.coerce.number().int().min(1).max(10).catch(3).parse(request.retentionCount);
        const retentionDays = z.coerce.number().int().min(1).max(30).catch(7).parse(request.retentionDays);
        await runExtractionJob(
          job,
          mode,
          mediaSources.success ? mediaSources.data : defaultBackupMediaSources,
          retentionCount,
          retentionDays
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Backup job could not be processed';
        await prisma.extractionJob.updateMany({
          where: { id: job.id, status: 'processing', leaseOwner: extractionWorkerId },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: message,
            progress: extractionProgress(0, 'failed', message),
            leaseOwner: null,
            leaseUntil: null
          }
        });
        const failed = await prisma.extractionJob.findUnique({ where: { id: job.id } });
        if (failed) {
          emitToUser(job.createdBy, 'settings.extraction.updated', {
            job: serializeExtractionJob(failed) as Record<string, unknown>
          });
        }
      }
    }
  } finally {
    extractionWorkerTicking = false;
  }
};

export const startExtractionWorker = () => {
  if (extractionWorkerTimer) return () => undefined;
  void runExtractionWorkerTick().catch((error) => {
    console.error('Extraction worker initial tick failed', error);
  });
  extractionWorkerTimer = setInterval(() => {
    void runExtractionWorkerTick().catch((error) => {
      console.error('Extraction worker tick failed', error);
    });
  }, EXTRACTION_WORKER_POLL_MS);
  extractionWorkerTimer.unref();
  return () => {
    if (extractionWorkerTimer) clearInterval(extractionWorkerTimer);
    extractionWorkerTimer = null;
  };
};

registerScheduledTaskHandler('extraction.backup', async (task, scheduledFor) => {
  const payload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
    ? task.payload as Record<string, unknown>
    : {};
  const mode = z.enum(['db', 'images', 'all']).catch('all').parse(payload.mode);
  const mediaSources = z.array(backupMediaSourceSchema).catch(defaultBackupMediaSources).parse(payload.mediaSources);
  const retentionCount = z.coerce.number().int().min(1).max(10).catch(3).parse(payload.retentionCount);
  const retentionDays = z.coerce.number().int().min(1).max(30).catch(7).parse(payload.retentionDays);
  const job = await createExtractionJob({
    mode,
    mediaSources,
    autoDownload: false,
    actor: task.updatedBy,
    idempotencyKey: `schedule:${task.id}:${scheduledFor.toISOString()}`,
    source: 'scheduled',
    retentionCount,
    retentionDays
  });
  return { jobId: job.id, status: job.status };
});

const migrationProgress = (percent: number, stage: string, message: string) => ({ percent, stage, message });
const MIGRATION_ASSET_PULL_MAX_ATTEMPTS = 4;
const MIGRATION_ASSET_PULL_BASE_DELAY_MS = 750;

const requireMigrationKey = (key?: string | null) => {
  if (!env.migrationKey) throw new Error('MIGRATION_KEY is not configured on this backend');
  if (!secretEquals(key, env.migrationKey)) throw new Error('Invalid migration key');
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
  const parsed = z.object({
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    source: z.object({ assetEndpoint: z.string().url() }),
    dataset: z.record(z.unknown()),
    assets: z.array(z.object({ objectPath: z.string().min(1).max(2048) })).max(100_000),
    summary: z.object({
      tables: z.record(z.number().int().nonnegative()),
      assetCount: z.number().int().nonnegative()
    })
  }).parse(JSON.parse(buffer.toString('utf8')));
  const assets = parsed.assets.map((asset) => {
    const objectPath = normalizeObjectPath(asset.objectPath);
    if (
      objectPath !== asset.objectPath ||
      !isReadableObjectPath(objectPath) ||
      isGeneratedBackupArtifactPath(objectPath)
    ) {
      throw new Error(`Migration payload contains an unsafe storage object path: ${asset.objectPath}`);
    }
    return { objectPath };
  });
  return {
    ...parsed,
    dataset: prepareMigrationDatasetForRestore(parsed.dataset),
    assets
  };
};

const backupManifestSchema = z.object({
  format: z.literal('morneven-zeroclaw-backup/v1'),
  generatedAt: z.string().datetime(),
  mode: z.enum(['db', 'images', 'all']),
  files: z.array(z.object({
    path: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).max(10_000)
}).strict();

const encryptedBackupRecordSchema = z.object({
  encryptedValue: z.string().min(1)
}).passthrough();

const zeroClawRuntimeBackupSchema = z.object({
  format: z.literal('morneven-zeroclaw-runtime-backup/v1'),
  restoreState: z.literal('disabled'),
  generalConfig: z.array(z.record(z.unknown())),
  identities: z.array(z.record(z.unknown())),
  files: z.array(z.record(z.unknown())),
  encryptedProviderAccounts: z.array(encryptedBackupRecordSchema).optional().default([]),
  encryptedCredentials: z.array(encryptedBackupRecordSchema),
  encryptedOpenRouterProfiles: z.array(encryptedBackupRecordSchema),
  encryptedAnalyticsCredentials: z.array(encryptedBackupRecordSchema)
}).passthrough();

const scheduleDefinitionsBackupSchema = z.object({
  format: z.literal('morneven-schedules/v1'),
  restoreState: z.literal('disabled'),
  tasks: z.array(z.object({
    key: z.string().min(1),
    kind: z.string().min(1),
    targetId: z.string().nullable(),
    timezone: z.string().min(1),
    schedule: z.unknown(),
    payload: z.unknown(),
    createdBy: z.string().min(1),
    updatedBy: z.string().min(1)
  }).passthrough())
}).passthrough();

const runtimeControlBackupSchema = z.object({
  format: z.literal('morneven-runtime-control-state/v1'),
  restoreState: z.literal('stopped'),
  previousState: z.record(z.unknown()).nullable()
}).passthrough();

const attachmentManifestSchema = z.object({
  embeddedAssets: z.array(z.object({
    objectPath: z.string().min(1).max(2048),
    archivePath: z.string().min(1).max(1024),
    source: backupMediaSourceSchema.optional(),
    size: z.number().int().nonnegative().optional(),
    contentType: z.string().min(1).max(200).optional()
  }).passthrough()).max(10_000).default([])
}).passthrough();

type ScannerBlockedAsset = {
  objectPath: string;
  reason: string;
};

type ValidatedAttachmentManifest = z.infer<typeof attachmentManifestSchema> & {
  scannerBlockedAssets: ScannerBlockedAsset[];
  skippedScannerAssets: ScannerBlockedAsset[];
};

const parseArchiveJson = <T>(files: Map<string, Buffer>, name: string, schema: z.ZodType<T>): T => {
  const entry = files.get(name);
  if (!entry) throw new Error(`Backup archive does not include ${name}`);
  try {
    return schema.parse(JSON.parse(entry.toString('utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Backup archive')) throw error;
    throw new Error(`Backup archive contains invalid ${name}`);
  }
};

const backupContentTypesByExtension: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.toml': 'text/plain',
  '.txt': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
};

const parseAllowedBlockedFiles = (raw: string | undefined) => {
  if (raw === undefined) return { provided: false, paths: new Set<string>() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('allowBlockedFiles must be a JSON array');
  }
  const paths = z.array(z.string().min(1).max(2048)).max(100).parse(parsed);
  return { provided: true, paths: new Set(paths) };
};

const validateAttachmentManifest = (
  files: Map<string, Buffer>,
  allowedBlockedPaths = new Set<string>()
): ValidatedAttachmentManifest => {
  const manifestFile = files.get('attachments/manifest.json');
  if (!manifestFile) return { embeddedAssets: [], scannerBlockedAssets: [], skippedScannerAssets: [] };
  let parsed: z.infer<typeof attachmentManifestSchema>;
  try {
    parsed = attachmentManifestSchema.parse(JSON.parse(manifestFile.toString('utf8')));
  } catch {
    throw new Error('Backup archive contains an invalid attachments/manifest.json');
  }

  const objectPaths = new Set<string>();
  const archivePaths = new Set<string>();
  const scannerBlockedAssets: ScannerBlockedAsset[] = [];
  const skippedScannerAssets: ScannerBlockedAsset[] = [];
  const embeddedAssets = parsed.embeddedAssets.flatMap((asset) => {
    const objectPath = normalizeObjectPath(asset.objectPath);
    if (
      objectPath !== asset.objectPath ||
      !isReadableObjectPath(objectPath) ||
      isGeneratedBackupArtifactPath(objectPath)
    ) {
      throw new Error(`Backup archive contains an unsafe storage object path: ${asset.objectPath}`);
    }
    if (!asset.archivePath.startsWith('attachments/') || asset.archivePath === 'attachments/manifest.json') {
      throw new Error(`Backup archive contains an invalid attachment path: ${asset.archivePath}`);
    }
    if (objectPaths.has(objectPath) || archivePaths.has(asset.archivePath)) {
      throw new Error('Backup archive contains duplicate attachment mappings');
    }
    objectPaths.add(objectPath);
    archivePaths.add(asset.archivePath);
    const content = files.get(asset.archivePath);
    if (!content) throw new Error(`Backup archive is missing ${asset.archivePath}`);
    if (asset.size !== undefined && content.length !== asset.size) {
      throw new Error(`Backup archive attachment size mismatch for ${asset.objectPath}`);
    }
    const contentType =
      asset.contentType ??
      backupContentTypesByExtension[path.extname(objectPath).toLowerCase()] ??
      (objectPath.startsWith('bot-manager/workspace/') ? 'text/plain' : undefined) ??
      'application/octet-stream';
    const inspection = inspectUploadBuffer({ objectPath, buffer: content, mime: contentType });
    if (inspection.verdict === 'blocked' || inspection.verdict === 'quarantined') {
      const blocked = {
        objectPath,
        reason: inspection.reason ?? inspection.verdict
      };
      scannerBlockedAssets.push(blocked);
      if (!allowedBlockedPaths.has(objectPath)) {
        skippedScannerAssets.push(blocked);
        return [];
      }
      // Archive/path validation is the trust boundary; author approval may restore blocked content.
      if (inspection.verdict === 'quarantined') {
        throw new Error(`Backup archive attachment is quarantined and cannot be approved for ${objectPath}`);
      }
    }
    return [{ ...asset, objectPath, contentType }];
  });
  return { ...parsed, embeddedAssets, scannerBlockedAssets, skippedScannerAssets };
};

const parseValidatedBackupArchive = (buffer: Buffer) => {
  const entries = readZip(buffer, {
    maxEntries: 10_000,
    maxTotalUncompressedBytes: MIGRATION_BACKUP_UPLOAD_LIMIT_MB * 1024 * 1024,
    maxEntryUncompressedBytes: 256 * 1024 * 1024
  });
  const files = new Map(entries.map((entry) => [entry.name, entry.content]));
  const manifest = parseArchiveJson(files, 'manifest.json', backupManifestSchema);
  const listedPaths = new Set<string>();
  for (const entry of manifest.files) {
    if (entry.path === 'manifest.json' || listedPaths.has(entry.path)) {
      throw new Error('Backup archive manifest contains a duplicate or self-referencing file entry');
    }
    const content = files.get(entry.path);
    if (!content) throw new Error(`Backup archive is missing ${entry.path}`);
    if (content.length !== entry.size) {
      throw new Error(`Backup archive size mismatch for ${entry.path}`);
    }
    const digest = createHash('sha256').update(content).digest('hex');
    if (!secretEquals(digest, entry.sha256)) {
      throw new Error(`Backup archive checksum mismatch for ${entry.path}`);
    }
    listedPaths.add(entry.path);
  }
  const actualPaths = Array.from(files.keys()).filter((name) => name !== 'manifest.json');
  if (
    actualPaths.length !== listedPaths.size ||
    actualPaths.some((name) => !listedPaths.has(name))
  ) {
    throw new Error('Backup archive contains files that are not covered by the manifest');
  }
  return { files, manifest };
};

const parseMigrationDatasetFromBackup = (buffer: Buffer, allowedBlockedPaths = new Set<string>()) => {
  const { files } = parseValidatedBackupArchive(buffer);
  parseArchiveJson(files, 'zeroclaw/runtime-bundle.json', zeroClawRuntimeBackupSchema);
  parseArchiveJson(files, 'schedules/definitions.json', scheduleDefinitionsBackupSchema);
  parseArchiveJson(files, 'zeroclaw/runtime-control-state.json', runtimeControlBackupSchema);
  const attachments = validateAttachmentManifest(files, allowedBlockedPaths);
  const datasetFile = files.get('db/morneven-full-dataset.json');
  if (!datasetFile) throw new Error('Backup archive does not include db/morneven-full-dataset.json');
  const rawDataset = JSON.parse(datasetFile.toString('utf8')) as unknown;
  const dataset = prepareMigrationDatasetForRestore(rawDataset);
  return { files, dataset, attachments };
};

const backupArchiveAssetCount = (attachments: ValidatedAttachmentManifest) =>
  attachments.embeddedAssets.length;

const importParsedBackupArchive = async (
  files: Map<string, Buffer>,
  dataset: MigrationDataset,
  attachments: ValidatedAttachmentManifest
): Promise<MigrationVerification> => {
  await importMigrationDataset(dataset);

  let uploadedAssetCount = 0;
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  for (const asset of attachments.embeddedAssets) {
    const content = files.get(asset.archivePath)!;
    try {
      await saveFileToStorage({
        objectPath: asset.objectPath,
        buffer: content,
        contentType: asset.contentType ?? 'application/octet-stream'
      });
      uploadedAssetCount += 1;
    } catch (error) {
      failedAssets.push({
        objectPath: asset.objectPath,
        error: error instanceof Error ? error.message : 'Unknown asset restore failure'
      });
    }
  }

  const counts = await countCurrentMigrationState();
  return {
    tables: counts.tables,
    assetCount: counts.assetCount,
    uploadedAssetCount,
    failedAssets,
    skippedAssets: attachments.skippedScannerAssets
  };
};

const importBackupArchive = async (buffer: Buffer): Promise<MigrationVerification> => {
  const { files, dataset, attachments } = parseMigrationDatasetFromBackup(buffer);
  if (attachments.scannerBlockedAssets.length) {
    throw new Error(`Backup archive requires scanner approval for ${attachments.scannerBlockedAssets.map((asset) => asset.objectPath).join(', ')}`);
  }
  return importParsedBackupArchive(files, dataset, attachments);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRetryAfterMs = (value: string | null) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
};

const retryableMigrationAssetStatuses = new Set([408, 429, 500, 502, 503, 504]);

const migrationAssetFailureMessage = async (response: globalThis.Response) => {
  let detail = '';
  try {
    const payload = await response.text();
    detail = payload ? `: ${payload.slice(0, 240)}` : '';
  } catch {
    detail = '';
  }
  return `Source asset responded with ${response.status}${detail}`;
};

const fetchMigrationAsset = async (url: string, migrationKey: string) => {
  for (let attempt = 1; attempt <= MIGRATION_ASSET_PULL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        'x-migration-key': migrationKey
      }
    });

    if (response.ok) return response;

    const shouldRetry = retryableMigrationAssetStatuses.has(response.status) && attempt < MIGRATION_ASSET_PULL_MAX_ATTEMPTS;
    if (!shouldRetry) {
      throw new Error(await migrationAssetFailureMessage(response));
    }

    const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
    await sleep(retryAfter ?? MIGRATION_ASSET_PULL_BASE_DELAY_MS * attempt);
  }

  throw new Error('Source asset transfer failed');
};

const pullMigrationAssets = async (payload: MigrationPayload, migrationKey: string): Promise<MigrationVerification> => {
  let uploadedAssetCount = 0;
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  for (const asset of payload.assets) {
    try {
      const url = `${payload.source.assetEndpoint}?path=${encodeURIComponent(asset.objectPath)}`;
      const response = await fetchMigrationAsset(url, migrationKey);
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

const runBackupRestoreJob = async (
  jobId: string,
  actor: string,
  downloadName: string,
  backup: { originalName: string; buffer: Buffer; size: number; sha256: string; allowedBlockedPaths: Set<string> }
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
    await updateMetadata({
      progress: migrationProgress(15, 'validating-backup', 'Validating backup archive'),
      summary: {
        backupFile: backup.originalName,
        backupSize: backup.size,
        backupSha256: backup.sha256
      }
    });
    const { files, dataset, attachments } = parseMigrationDatasetFromBackup(backup.buffer, backup.allowedBlockedPaths);
    const expectedSummary = summarizeMigrationDataset(dataset, backupArchiveAssetCount(attachments));

    await updateMetadata({
      summary: {
        backupFile: backup.originalName,
        backupSize: backup.size,
        backupSha256: backup.sha256,
        ...expectedSummary
      },
      progress: migrationProgress(35, 'restoring-backup', 'Restoring backup archive into current backend')
    });
    const verification = await importParsedBackupArchive(files, dataset, attachments);

    await updateMetadata({ progress: migrationProgress(80, 'verifying', 'Comparing restored data with backup manifest') });
    const comparison = {
      tablesMatch: Object.entries(expectedSummary.tables).every(
        ([key, value]) => Number(verification.tables[key] ?? 0) === value
      ),
      assetsMatch: verification.assetCount === expectedSummary.assetCount,
      uploadedAssetsMatch: verification.uploadedAssetCount === expectedSummary.assetCount
    };

    const report = {
      exportedAt: new Date().toISOString(),
      actor,
      targetUrl: 'current-backend',
      method: 'backup-file',
      backup: {
        fileName: backup.originalName,
        size: backup.size,
        sha256: backup.sha256
      },
      expectedSummary,
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
      progress: migrationProgress(100, 'completed', 'Backup restored into current backend')
    });
  } catch (error) {
    await updateMetadata({
      status: 'failed',
      error: error instanceof Error ? error.message : 'Backup restore failed',
      progress: migrationProgress(100, 'failed', 'Backup restore failed')
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

const getStorageReadStatus = (error: unknown) => {
  const record = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = Number(record.status ?? record.statusCode ?? record.$metadata?.httpStatusCode);
  const name = typeof record.name === 'string' ? record.name : '';
  if (record.code === 'ENOENT' || record.code === 'NoSuchKey' || name === 'NoSuchKey' || status === 404) return 404;
  if (status === 403) return 403;
  return 500;
};

settingsRouter.get('/migration/assets', async (req, res) => {
  try {
    requireMigrationKey(req.header('x-migration-key'));
    const objectPath = extractStorageObjectPath(String(req.query.path ?? ''));
    if (!objectPath) return fail(res, 422, 'Invalid object path', 'VALIDATION_ERROR');
    try {
      const stored = await readFileWithMetadataFromStorage(objectPath);
      res.setHeader('Content-Type', stored.contentType ?? 'application/octet-stream');
      return res.send(stored.buffer);
    } catch (error) {
      const status = getStorageReadStatus(error);
      if (status === 404) return fail(res, 404, 'Storage object not found', 'STORAGE_OBJECT_NOT_FOUND');
      if (status === 403) return fail(res, 403, 'Storage object is not readable', 'STORAGE_FORBIDDEN');
      return fail(res, 500, 'Storage object read failed', 'STORAGE_ERROR');
    }
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

settingsRouter.post('/migration/receive-backup', (req, res, next) => {
  try {
    requireMigrationKey(req.header('x-migration-key'));
    next();
  } catch (error) {
    return fail(res, 403, error instanceof Error ? error.message : 'Forbidden', 'FORBIDDEN');
  }
}, migrationBackupUploadSingle, async (req, res) => {
  try {
    if (!req.file?.buffer) return fail(res, 422, 'Backup archive is required', 'VALIDATION_ERROR');
    const verification = await importBackupArchive(req.file.buffer);
    return ok(res, verification);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Backup migration receive failed', 'MIGRATION_ERROR');
  }
});

settingsRouter.get('/extractions', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);
  const jobs = await prisma.extractionJob.findMany({
    where: { createdBy: req.user!.username, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
  return ok(res, jobs.map(serializeExtractionJob));
});

settingsRouter.get('/extraction/schedule', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const task = await prisma.scheduledTask.findUnique({ where: { key: 'extraction.backup' } });
  return ok(res, serializeScheduledTask(task));
});

settingsRouter.put('/extraction/schedule', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const parsed = extractionScheduleSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !await bcrypt.compare(parsed.data.password, user.passwordHash)) {
      throw new Error('Password confirmation failed');
    }
    const task = await upsertScheduledTask({
      key: 'extraction.backup',
      kind: 'extraction.backup',
      timezone: parsed.data.timezone,
      schedule: parsed.data.schedule,
      payload: {
        mode: parsed.data.mode,
        mediaSources: parsed.data.mediaSources,
        retentionCount: parsed.data.retentionCount,
        retentionDays: parsed.data.retentionDays
      },
      actor: req.user!.username
    });
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: 'extraction.schedule.update',
      entity: 'ScheduledTask',
      entityId: task.id,
      metadata: {
        timezone: task.timezone,
        nextRunAt: task.nextRunAt?.toISOString(),
        retentionCount: parsed.data.retentionCount,
        retentionDays: parsed.data.retentionDays
      }
    });
    return ok(res, serializeScheduledTask(task));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup schedule update failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN');
  }
});

settingsRouter.delete('/extraction/schedule', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const parsed = extractionScheduleDeleteSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !await bcrypt.compare(parsed.data.password, user.passwordHash)) {
      throw new Error('Password confirmation failed');
    }
    const task = await deleteScheduledTask('extraction.backup');
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: 'extraction.schedule.delete',
      entity: 'ScheduledTask',
      entityId: task?.id,
      metadata: { deleted: Boolean(task) }
    });
    return ok(res, { deleted: Boolean(task) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup schedule delete failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN');
  }
});

settingsRouter.post('/extractions', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);

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

  const requestedIdempotencyKey = req.header('Idempotency-Key')?.trim();
  const job = await createExtractionJob({
    mode: parsed.data.mode,
    mediaSources: parsed.data.mediaSources,
    autoDownload: parsed.data.autoDownload,
    actor: req.user!.username,
    idempotencyKey: requestedIdempotencyKey || randomUUID(),
    source: 'manual'
  });
  return res.status(202).json({ success: true, data: serializeExtractionJob(job) });
});

settingsRouter.get('/extractions/:id', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);
  const job = await prisma.extractionJob.findFirst({
    where: { id: req.params.id, createdBy: req.user!.username, expiresAt: { gt: new Date() } }
  });
  if (!job) return fail(res, 404, 'Extraction job not found', 'NOT_FOUND');
  return ok(res, serializeExtractionJob(job));
});

settingsRouter.post('/extractions/:id/retry', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);
  const parsed = extractionRetrySchema.safeParse(req.body);
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

  const existing = await prisma.extractionJob.findFirst({
    where: { id: req.params.id, createdBy: req.user!.username, expiresAt: { gt: new Date() } }
  });
  if (!existing) return fail(res, 404, 'Extraction job not found', 'NOT_FOUND');

  const mode = z.enum(['db', 'images', 'all']).safeParse(existing.mode);
  if (!mode.success) return fail(res, 409, 'Extraction job mode is not retryable', 'EXTRACTION_RETRY_UNAVAILABLE');
  if (existing.status === 'queued' || existing.status === 'processing') {
    await stopExtractionJob(existing, req.user!.username, 'Backup job stopped before retry. New retry starts from 0%.');
  }

  const existingRequest = extractionRequestRecord(existing);
  const requestedIdempotencyKey = req.header('Idempotency-Key')?.trim();
  const job = await createExtractionJob({
    mode: mode.data,
    mediaSources: parsed.data.mediaSources,
    autoDownload: parsed.data.autoDownload ?? existing.autoDownload,
    actor: req.user!.username,
    idempotencyKey: requestedIdempotencyKey || `retry:${existing.id}:${existing.attempt + 1}`,
    source: 'retry',
    parentJobId: existing.id,
    attempt: existing.attempt + 1,
    retentionCount: z.coerce.number().int().min(1).max(10).catch(3).parse(existingRequest.retentionCount),
    retentionDays: z.coerce.number().int().min(1).max(30).catch(7).parse(existingRequest.retentionDays)
  });

  return res.status(202).json({ success: true, data: serializeExtractionJob(job) });
});

settingsRouter.post('/extractions/:id/stop', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);
  const job = await prisma.extractionJob.findFirst({
    where: { id: req.params.id, createdBy: req.user!.username, expiresAt: { gt: new Date() } }
  });
  if (!job) return fail(res, 404, 'Extraction job not found', 'NOT_FOUND');
  if (!['queued', 'processing'].includes(job.status)) return fail(res, 409, 'Extraction job is not running', 'EXTRACTION_NOT_RUNNING');

  const stopped = await stopExtractionJob(job, req.user!.username, 'Backup job stopped by user. Retry to start again from 0%.');
  if (!stopped) return fail(res, 409, 'Extraction job is not running', 'EXTRACTION_NOT_RUNNING');
  return ok(res, serializeExtractionJob(stopped));
});

settingsRouter.post('/extractions/:id/download-ticket', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  await stopStaleExtractionJobs(req.user!.username);
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

  const job = await prisma.extractionJob.findFirst({
    where: { id: req.params.id, createdBy: req.user!.username, expiresAt: { gt: new Date() } }
  });
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
    const job = await prisma.extractionJob.findFirst({
      where: { id: payload.jobId, createdBy: payload.actor, expiresAt: { gt: new Date() } }
    });
    if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
    return sendExtractionDownload(res, job, payload.actor);
  } catch (error) {
    return fail(res, 403, error instanceof Error ? error.message : 'Invalid download ticket', 'FORBIDDEN');
  }
});

settingsRouter.get('/extractions/:id/download', auth, async (req, res) => {
  if (!requirePl7Author(req, res)) return;
  const job = await prisma.extractionJob.findFirst({
    where: { id: req.params.id, createdBy: req.user!.username, expiresAt: { gt: new Date() } }
  });
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
  if (!secretEquals(parsed.data.secretKey, env.migrationKey)) {
    return fail(res, 403, 'Migration secret key is invalid', 'FORBIDDEN');
  }

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

settingsRouter.post('/migrations/from-backup', auth, migrationBackupUploadSingle, async (req, res) => {
  if (!requirePl7Author(req, res)) return;

  const parsed = backupMigrationSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  if (!req.file?.buffer) return fail(res, 422, 'Backup archive is required', 'VALIDATION_ERROR');
  if (!env.migrationKey) return fail(res, 503, 'Migration key is not configured', 'MIGRATION_UNAVAILABLE');

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordOk) return fail(res, 403, 'Password confirmation failed', 'FORBIDDEN');
  if (!secretEquals(parsed.data.secretKey, env.migrationKey)) {
    return fail(res, 403, 'Migration secret key is invalid', 'FORBIDDEN');
  }

  let scannerApproval: ReturnType<typeof parseAllowedBlockedFiles>;
  try {
    scannerApproval = parseAllowedBlockedFiles(parsed.data.allowBlockedFiles);
  } catch (error) {
    return fail(res, 422, error instanceof Error ? error.message : 'Invalid scanner approval', 'VALIDATION_ERROR');
  }
  let preflight: ReturnType<typeof parseMigrationDatasetFromBackup>;
  try {
    preflight = parseMigrationDatasetFromBackup(req.file.buffer, scannerApproval.paths);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : 'Backup archive validation failed', 'MIGRATION_ERROR');
  }
  if (preflight.attachments.scannerBlockedAssets.length && !scannerApproval.provided) {
    return fail(
      res,
      409,
      'Backup contains files blocked by the security scanner. Review and approve the files to restore.',
      'BACKUP_SCANNER_APPROVAL_REQUIRED',
      preflight.attachments.scannerBlockedAssets.map((asset) => ({
        path: asset.objectPath,
        message: asset.reason
      }))
    );
  }

  const createdAt = new Date();
  const downloadName = `morneven-migration-report-${createdAt.toISOString().slice(0, 10)}.json`;
  const backup = {
    originalName: req.file.originalname || 'backup.zip',
    buffer: req.file.buffer,
    size: req.file.size,
    sha256: createHash('sha256').update(req.file.buffer).digest('hex'),
    allowedBlockedPaths: scannerApproval.paths
  };
  const job = await prisma.auditLog.create({
    data: {
      actor: req.user!.username,
      action: 'migration.job',
      entity: 'MigrationJob',
      metadata: {
        status: 'processing',
        method: 'backup-file',
        targetUrl: 'current-backend',
        downloadName,
        progress: migrationProgress(0, 'queued', 'Queued')
      }
    }
  });

  setImmediate(() => {
    void runBackupRestoreJob(job.id, req.user!.username, downloadName, backup);
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
