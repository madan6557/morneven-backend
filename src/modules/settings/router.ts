import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { EntityType, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { saveFileToStorage } from '../../config/storage.js';
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
  await prisma.$transaction([
    prisma.commandCenterSettings.updateMany({ where: { isActive: true }, data: { isActive: false } }),
    prisma.commandCenterSettings.update({ where: { id: req.params.id }, data: { isActive: true, updatedBy: req.user!.username } })
  ]);
  return ok(res, { activatedPresetId: req.params.id });
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

const buildExtractionFiles = async (mode: 'db' | 'images' | 'all'): Promise<ZipFile[]> => {
  const files: ZipFile[] = [];

  if (mode === 'db' || mode === 'all') {
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

    files.push({ name: 'db/characters.json', content: JSON.stringify(loreByType(EntityType.character), null, 2) });
    files.push({ name: 'db/creatures.json', content: JSON.stringify(loreByType(EntityType.creature), null, 2) });
    files.push({ name: 'db/places.json', content: JSON.stringify(loreByType(EntityType.place), null, 2) });
    files.push({ name: 'db/projects.json', content: JSON.stringify(projects.map(serializeProject), null, 2) });
    files.push({ name: 'db/technology.json', content: JSON.stringify(loreByType(EntityType.technology), null, 2) });
    files.push({ name: 'db/events.json', content: JSON.stringify(loreByType(EntityType.event), null, 2) });
    files.push({ name: 'db/others.json', content: JSON.stringify(loreByType(EntityType.other), null, 2) });
    files.push({ name: 'db/gallery.json', content: JSON.stringify(gallery.map((item) => serializeGalleryItem(item)), null, 2) });
    files.push({ name: 'db/news.json', content: JSON.stringify(news, null, 2) });
    files.push({ name: 'db/personnel.json', content: JSON.stringify(personnel.map(serializeUser), null, 2) });
    files.push({ name: 'db/map.json', content: JSON.stringify({ mapImage, markers: mapMarkers }, null, 2) });
  }

  if (mode === 'images' || mode === 'all') {
    const [gallery, mapImage] = await Promise.all([
      prisma.galleryItem.findMany({ include: { tags: true, uploader: true } }),
      prisma.mapImage.findUnique({ where: { id: 'main' } })
    ]);
    const imageItems = gallery.filter((item) => item.type === 'image').map((item) => serializeGalleryItem(item));
    const byTag = (tag: string) => imageItems.filter((item) => item.tags.includes(tag));

    files.push({ name: 'images/map/images.json', content: JSON.stringify([{ title: 'map', src: mapImage?.imageUrl ?? '' }], null, 2) });
    files.push({ name: 'images/character/images.json', content: JSON.stringify(byTag('character'), null, 2) });
    files.push({ name: 'images/creature/images.json', content: JSON.stringify(byTag('creature'), null, 2) });
    files.push({ name: 'images/technology/images.json', content: JSON.stringify(byTag('technology'), null, 2) });
    files.push({ name: 'images/environment/images.json', content: JSON.stringify(byTag('environment'), null, 2) });
    files.push({
      name: 'images/other/images.json',
      content: JSON.stringify(
        imageItems.filter((item) => !['character', 'creature', 'technology', 'environment'].some((tag) => item.tags.includes(tag))),
        null,
        2
      )
    });
  }

  return files;
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
    await prisma.extractionJob.update({
      where: { id: jobId },
      data: { progress: extractionProgress(10, 'collecting', 'Collecting export data') }
    });
    const files = await buildExtractionFiles(mode);

    await prisma.extractionJob.update({
      where: { id: jobId },
      data: { progress: extractionProgress(45, 'compressing', 'Compressing export archive') }
    });
    const zip = makeZip(files);

    await prisma.extractionJob.update({
      where: { id: jobId },
      data: { progress: extractionProgress(75, 'uploading', 'Uploading export artifact') }
    });
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
      metadata: { mode }
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

  if (env.storageDriver !== 'local') {
    return ok(res, { url: job.artifactUrl, downloadName: job.downloadName });
  }

  const fullPath = path.join(env.localStoragePath, job.artifactPath);
  const file = await readFile(fullPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.downloadName ?? 'morneven-export.zip'}"`);
  return res.send(file);
});

settingsRouter.delete('/extractions', auth, async (req, res) => {
  if (!requirePl7(req, res)) return;
  const parsed = clearExtractionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const where = parsed.data.ids?.length
    ? { createdBy: req.user!.username, id: { in: parsed.data.ids } }
    : { createdBy: req.user!.username };
  const result = await prisma.extractionJob.deleteMany({ where });
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'extraction.delete',
    entity: 'ExtractionJob',
    metadata: { count: result.count }
  });
  return ok(res, { deleted: result.count });
});
