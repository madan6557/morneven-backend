import { Router } from 'express';
import { MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth, allow, canWriteNews } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parsePagination } from '../../utils/pagination.js';
import { serializeNewsItem } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { cleanupUnreferencedStoragePaths, collectNewsStoragePathSet, diffStoragePaths } from '../../utils/storage-cleanup.js';

export const newsRouter = Router();

const attachmentSchema = z.object({
  type: z.enum(['image', 'video', 'link']),
  url: z.string().min(1),
  caption: z.string().optional()
});

const newsSchema = z.object({
  text: z.string().min(1),
  hasDetail: z.boolean().optional().default(false),
  thumbnail: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
  publishDate: z.string().optional(),
  date: z.string().optional(),
  attachments: z.array(attachmentSchema).optional().default([])
});

const newsUpdateSchema = newsSchema.partial();

const toMediaType = (type: string) => (type === 'video' ? MediaType.video : type === 'link' ? MediaType.link : MediaType.image);

newsRouter.get('/', auth, async (req, res) => {
  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 24, maxPageSize: 100 });
  const q = getSearchQuery(req);
  const where: Prisma.NewsWhereInput = q
    ? {
        OR: [
          { text: { contains: q, mode: 'insensitive' } },
          { body: { contains: q, mode: 'insensitive' } }
        ]
      }
    : {};

  const [items, total] = await Promise.all([
    prisma.news.findMany({ where, include: { attachments: true }, orderBy: { publishDate: 'desc' }, skip, take }),
    prisma.news.count({ where })
  ]);
  return ok(res, paginated(items.map(serializeNewsItem), page, pageSize, total));
});

newsRouter.get('/:id', auth, async (req, res) => {
  const item = await prisma.news.findUnique({ where: { id: req.params.id }, include: { attachments: true } });
  if (!item) return fail(res, 404, 'News not found', 'NOT_FOUND');
  return ok(res, serializeNewsItem(item));
});

newsRouter.post('/', auth, allow(canWriteNews), validateBody(newsSchema), async (req, res) => {
  const created = await prisma.news.create({
    data: {
      text: req.body.text,
      authorId: req.user!.id,
      publishDate: new Date(req.body.publishDate ?? req.body.date ?? Date.now()),
      hasDetail: req.body.hasDetail,
      thumbnail: req.body.thumbnail || null,
      body: req.body.body || null,
      attachments: {
        create: req.body.attachments.map((attachment: { type: string; url: string; caption?: string }) => ({
          type: toMediaType(attachment.type),
          url: attachment.url,
          caption: attachment.caption
        }))
      }
    },
    include: { attachments: true }
  });
  await writeAudit(prisma, { actor: req.user!.username, action: 'news.create', entity: 'News', entityId: created.id });
  return res.status(201).json({ success: true, data: serializeNewsItem(created) });
});

newsRouter.put('/:id', auth, allow(canWriteNews), validateBody(newsUpdateSchema), async (req, res) => {
  const existing = await prisma.news.findUnique({ where: { id: req.params.id }, include: { attachments: true } });
  if (!existing) return fail(res, 404, 'News not found', 'NOT_FOUND');
  const previousPaths = collectNewsStoragePathSet(existing);

  const updated = await prisma.$transaction(async (tx) => {
    if (req.body.attachments) {
      await tx.newsAttachment.deleteMany({ where: { newsId: req.params.id } });
      await tx.newsAttachment.createMany({
        data: req.body.attachments.map((attachment: { type: string; url: string; caption?: string }) => ({
          newsId: req.params.id,
          type: toMediaType(attachment.type),
          url: attachment.url,
          caption: attachment.caption
        }))
      });
    }
    const item = await tx.news.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.text !== undefined ? { text: req.body.text } : {}),
        ...(req.body.hasDetail !== undefined ? { hasDetail: req.body.hasDetail } : {}),
        ...(req.body.thumbnail !== undefined ? { thumbnail: req.body.thumbnail || null } : {}),
        ...(req.body.body !== undefined ? { body: req.body.body || null } : {}),
        ...(req.body.publishDate || req.body.date ? { publishDate: new Date(req.body.publishDate ?? req.body.date) } : {})
      },
      include: { attachments: true }
    });
    await writeAudit(tx, { actor: req.user!.username, action: 'news.update', entity: 'News', entityId: item.id });
    return item;
  });
  await cleanupUnreferencedStoragePaths(diffStoragePaths(previousPaths, collectNewsStoragePathSet(updated)));
  return ok(res, serializeNewsItem(updated));
});

newsRouter.delete('/:id', auth, allow(canWriteNews), async (req, res) => {
  const existing = await prisma.news.findUnique({ where: { id: req.params.id }, include: { attachments: true } });
  if (!existing) return fail(res, 404, 'News not found', 'NOT_FOUND');
  const previousPaths = collectNewsStoragePathSet(existing);

  await prisma.$transaction(async (tx) => {
    await tx.newsAttachment.deleteMany({ where: { newsId: req.params.id } });
    await tx.news.delete({ where: { id: req.params.id } });
  });
  await cleanupUnreferencedStoragePaths(previousPaths);
  await writeAudit(prisma, { actor: req.user!.username, action: 'news.delete', entity: 'News', entityId: req.params.id });
  return ok(res, { deleted: true });
});
