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
import { saveFileToStorage } from '../../config/storage.js';
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
  normalizeMigrationDataset,
  summarizeMigrationDataset,
  type ExportSnapshot,
  type MigrationDataset,
  type MigrationPayload,
  type MigrationVerification
} from '../../utils/data-contract.js';
import { makeZip, ZipFile } from '../../utils/zip.js';
import { writeAudit } from '../../utils/audit.js';
import { defaultCommandCenterSettings, ensureActiveCommandCenterPreset } from './preset-service.js';
import {
  cleanupUnreferencedStoragePaths,
  extractStorageObjectPath,
  getStorageCleanupReport,
  runStorageCleanup
} from '../../utils/storage-cleanup.js';
import { emitToUser } from '../../realtime/events.js';

export const settingsRouter = Router();

const defaultSettings = defaultCommandCenterSettings;
const MIGRATION_BACKUP_UPLOAD_LIMIT_MB = 1024;
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
  secretKey: z.string().min(16)
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
    botManagerBackupJobs,
    loreItems,
    docs
  ] = await Promise.all([
    prisma.chatMessage.findMany({ select: { attachments: true } }),
    prisma.galleryItem.findMany({ include: { tags: true } }),
    prisma.project.findMany(),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.mapImage.findUnique({ where: { id: 'main' } }),
    prisma.botManagerIdentity.findMany(),
    prisma.botManagerIdentityFile.findMany(),
    prisma.botManagerBackupJob.findMany({ select: { artifactPath: true, artifactUrl: true } }),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany()
  ]);

  for (const message of chatMessages) addPathSetValue(sets.chat, message.attachments);
  for (const item of galleryItems) addPathSetValue(sets.gallery, item);
  for (const project of projects) addPathSetValue(sets.projects, project);
  for (const item of news) addPathSetValue(sets.news, item);
  addPathSetValue(sets.map, mapImage?.imageUrl);
  for (const identity of botManagerIdentities) addPathSetValue(sets['bot-manager'], identity);
  for (const file of botManagerFiles) addPathSetValue(sets['bot-manager'], file.objectPath);
  for (const job of botManagerBackupJobs) {
    addPathSetValue(sets['bot-manager'], job.artifactPath);
    addPathSetValue(sets['bot-manager'], job.artifactUrl);
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
    files.push({ name: 'db/bot-manager.json', content: JSON.stringify(exportedSnapshot.botManager, null, 2) });
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

const formatBackupDownloadName = (date: Date) => {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const bb = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `backup_${dd}${bb}${yy}${hh}${ss}.zip`;
};

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
  parsed.dataset = normalizeMigrationDataset(parsed.dataset);
  return parsed;
};

const parseStoredZip = (buffer: Buffer) => {
  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error('Unsupported backup archive structure');

    const method = buffer.readUInt16LE(offset + 8);
    if (method !== 0) throw new Error('Backup archive uses unsupported compression');

    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length) throw new Error('Backup archive is truncated');
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    if (!name.endsWith('/')) files.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  return files;
};

const parseMigrationDatasetFromBackup = (buffer: Buffer) => {
  const files = parseStoredZip(buffer);
  const datasetFile = files.get('db/morneven-full-dataset.json');
  if (!datasetFile) throw new Error('Backup archive does not include db/morneven-full-dataset.json');
  const dataset = normalizeMigrationDataset(JSON.parse(datasetFile.toString('utf8')) as Partial<MigrationDataset>);
  return { files, dataset };
};

const backupArchiveAssetCount = (files: Map<string, Buffer>) => {
  const manifestFile = files.get('attachments/manifest.json');
  if (!manifestFile) return 0;
  const manifest = JSON.parse(manifestFile.toString('utf8')) as {
    embeddedAssets?: Array<{ objectPath: string; archivePath: string; contentType?: string }>;
  };
  return manifest.embeddedAssets?.length ?? 0;
};

const importParsedBackupArchive = async (files: Map<string, Buffer>, dataset: MigrationDataset): Promise<MigrationVerification> => {
  await importMigrationDataset(dataset);

  const manifestFile = files.get('attachments/manifest.json');
  let uploadedAssetCount = 0;
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  if (manifestFile) {
    const manifest = JSON.parse(manifestFile.toString('utf8')) as {
      embeddedAssets?: Array<{ objectPath: string; archivePath: string; contentType?: string }>;
    };

    for (const asset of manifest.embeddedAssets ?? []) {
      const content = files.get(asset.archivePath);
      if (!content) {
        failedAssets.push({ objectPath: asset.objectPath, error: 'Attachment missing from backup archive' });
        continue;
      }

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
  }

  const counts = await countCurrentMigrationState();
  return {
    tables: counts.tables,
    assetCount: counts.assetCount,
    uploadedAssetCount,
    failedAssets
  };
};

const importBackupArchive = async (buffer: Buffer): Promise<MigrationVerification> => {
  const { files, dataset } = parseMigrationDatasetFromBackup(buffer);
  return importParsedBackupArchive(files, dataset);
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

const runBackupRestoreJob = async (
  jobId: string,
  actor: string,
  downloadName: string,
  backup: { originalName: string; buffer: Buffer; size: number; sha256: string }
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
    const { files, dataset } = parseMigrationDatasetFromBackup(backup.buffer);
    const expectedSummary = summarizeMigrationDataset(dataset, backupArchiveAssetCount(files));

    await updateMetadata({
      summary: {
        backupFile: backup.originalName,
        backupSize: backup.size,
        backupSha256: backup.sha256,
        ...expectedSummary
      },
      progress: migrationProgress(35, 'restoring-backup', 'Restoring backup archive into current backend')
    });
    const verification = await importParsedBackupArchive(files, dataset);

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
  const downloadName = formatBackupDownloadName(createdAt);
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
  if (parsed.data.secretKey !== env.migrationKey) return fail(res, 403, 'Migration secret key is invalid', 'FORBIDDEN');

  const createdAt = new Date();
  const downloadName = `morneven-migration-report-${createdAt.toISOString().slice(0, 10)}.json`;
  const backup = {
    originalName: req.file.originalname || 'backup.zip',
    buffer: req.file.buffer,
    size: req.file.size,
    sha256: createHash('sha256').update(req.file.buffer).digest('hex')
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
