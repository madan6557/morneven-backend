import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { EntityType, MediaType, Prisma, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { saveFileToStorage } from '../../config/storage.js';
import { readFileFromStorage } from '../../config/storage.js';
import { readFileWithMetadataFromStorage } from '../../config/storage.js';
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
  extractStorageObjectPath,
  getStorageCleanupReport,
  runStorageCleanup
} from '../../utils/storage-cleanup.js';

export const settingsRouter = Router();

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

const extractionSchema = z.object({
  mode: z.enum(['db', 'images', 'all']),
  autoDownload: z.boolean().optional().default(false),
  confirmText: z.literal('CONFIRM'),
  password: z.string().min(1)
});

const clearExtractionSchema = z.object({
  ids: z.array(z.string()).optional()
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
  if (!req.user || req.user.level < 7) {
    fail(res, 403, 'PL7 access required', 'FORBIDDEN');
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
  map: {
    mapImage: string;
    markers: Awaited<ReturnType<typeof prisma.mapMarker.findMany>>;
  };
};

type EmbeddedAsset = {
  objectPath: string;
  archivePath: string;
  size?: number;
  contentType?: string;
};

type ExtractionBuildResult = {
  files: ZipFile[];
  mediaSummary: {
    embeddedCount: number;
    failedCount: number;
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

const collectExtractionSnapshot = async (): Promise<ExportSnapshot> => {
  const [projects, gallery, news, personnel, mapMarkers, mapImage, lore, docs] = await Promise.all([
    prisma.project.findMany({ include: { patches: true } }),
    prisma.galleryItem.findMany({ include: { tags: true, uploader: true } }),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.user.findMany(),
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

const buildExtractionFiles = async (
  mode: 'db' | 'images' | 'all',
  onProgress?: (percent: number, stage: string, message: string) => Promise<void>
): Promise<ExtractionBuildResult> => {
  const files: ZipFile[] = [];
  const snapshot = await collectExtractionSnapshot();
  const rawStoragePaths = Array.from(collectStoragePathsFromValue(snapshot)).sort((left, right) => left.localeCompare(right));
  const embeddedAssets = new Map<string, EmbeddedAsset>();
  const failedAssets: Array<{ objectPath: string; error: string }> = [];

  if (mode === 'images' || mode === 'all') {
    const totalAssets = rawStoragePaths.length;
    for (let index = 0; index < rawStoragePaths.length; index += 1) {
      const objectPath = rawStoragePaths[index];
      const progressBase = totalAssets === 0 ? 40 : 10 + Math.round(((index + 1) / totalAssets) * 50);
      await onProgress?.(progressBase, 'collecting-media', `Embedding media ${index + 1} of ${totalAssets}`);
      try {
        const stored = await readFileWithMetadataFromStorage(objectPath);
        const archivePath = `media/${objectPath}`;
        embeddedAssets.set(objectPath, {
          objectPath,
          archivePath,
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
    mode === 'images' || mode === 'all'
      ? rewriteExportMediaPaths(snapshot, embeddedAssets)
      : snapshot;

  if (mode === 'db' || mode === 'all') {
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
    files.push({ name: 'db/map.json', content: JSON.stringify(exportedSnapshot.map, null, 2) });
  }

  if (mode === 'images' || mode === 'all') {
    for (const manifest of buildImageManifests(exportedSnapshot)) {
      files.push({ name: manifest.name, content: JSON.stringify(manifest.value, null, 2) });
    }

    files.push({
      name: 'media/assets.json',
      content: JSON.stringify(
        {
          embeddedAssets: Array.from(embeddedAssets.values()).map((asset) => ({
            objectPath: asset.objectPath,
            archivePath: asset.archivePath,
            size: asset.size,
            contentType: asset.contentType
          })),
          failedAssets
        },
        null,
        2
      )
    });
  }

  return {
    files,
    mediaSummary: {
      embeddedCount: embeddedAssets.size,
      failedCount: failedAssets.length
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

const runExtractionJob = async (jobId: string, mode: 'db' | 'images' | 'all', actor: string, downloadName: string) => {
  try {
    const updateProgress = async (percent: number, stage: string, message: string) => {
      await prisma.extractionJob.update({
        where: { id: jobId },
        data: { progress: extractionProgress(percent, stage, message) }
      });
    };

    await updateProgress(10, 'collecting', 'Collecting export data');
    const { files, mediaSummary } = await buildExtractionFiles(mode, updateProgress);

    await updateProgress(70, 'compressing', 'Compressing export archive');
    const zip = makeZip(files);

    await updateProgress(85, 'uploading', 'Uploading export artifact');
    const objectPath = `exports/${jobId}/${downloadName}`;
    const stored = await saveFileToStorage({ objectPath, buffer: zip, contentType: 'application/zip' });

    const completed = await prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        artifactPath: stored.objectPath,
        artifactUrl: stored.url,
        progress: extractionProgress(100, 'completed', 'Export ready')
      }
    });
    await writeAudit(prisma, {
      actor,
      action: 'extraction.start',
      entity: 'ExtractionJob',
      entityId: completed.id,
      metadata: {
        mode,
        fileCount: files.length,
        embeddedMedia: mediaSummary.embeddedCount,
        failedMedia: mediaSummary.failedCount
      }
    });
  } catch (error) {
    await prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: (error as Error).message,
        progress: extractionProgress(100, 'failed', 'Export failed')
      }
    });
  }
};

settingsRouter.get('/extractions', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const jobs = await prisma.extractionJob.findMany({
    where: { createdBy: req.user!.username, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
  return ok(res, jobs.map(serializeExtractionJob));
});

settingsRouter.post('/extractions', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;

  const parsed = extractionSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const passwordOk = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordOk) return fail(res, 403, 'Password confirmation failed', 'FORBIDDEN');

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const downloadName = `morneven-extract-${parsed.data.mode}-${createdAt.toISOString().slice(0, 10)}.zip`;
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
    void runExtractionJob(job.id, parsed.data.mode, req.user!.username, downloadName);
  });

  return res.status(202).json({ success: true, data: serializeExtractionJob(job) });
});

settingsRouter.get('/extractions/:id', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const job = await prisma.extractionJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job) return fail(res, 404, 'Extraction job not found', 'NOT_FOUND');
  return ok(res, serializeExtractionJob(job));
});

settingsRouter.get('/extractions/:id/download', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const job = await prisma.extractionJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');

  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'extraction.download',
    entity: 'ExtractionJob',
    entityId: job.id
  });

  const file = await readFileFromStorage(job.artifactPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.downloadName ?? `morneven-extract-${job.id}.zip`}"`);
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
  if (!requirePl7(req, res)) return;
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
  return ok(res, { deleted: result.count });
});
