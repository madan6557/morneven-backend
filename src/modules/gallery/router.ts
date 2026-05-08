import { Router } from 'express';
import { EntityType, MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth, allow, canModerateDiscussion, canWriteGallery } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parseIds, parsePagination } from '../../utils/pagination.js';
import { dateOnly, serializeGalleryItem } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { cleanupUnreferencedStoragePaths, collectGalleryStoragePathSet, diffStoragePaths } from '../../utils/storage-cleanup.js';

export const galleryRouter = Router();

const gallerySchema = z.object({
  type: z.enum(['image', 'video']).default('image'),
  title: z.string().min(1).max(160),
  thumbnail: z.string().optional().default(''),
  videoUrl: z.string().optional(),
  caption: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  date: z.string().optional(),
  uploadedBy: z.string().optional()
});

const galleryUpdateSchema = gallerySchema.partial();

const serializeComments = (
  comments: Prisma.CommentGetPayload<{ include: { author: true; replies: { include: { author: true } } } }>[]
) =>
  comments.map((comment) => ({
    id: comment.id,
    author: comment.author.username,
    text: comment.text,
    date: dateOnly(comment.createdAt),
    mentions: [],
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      author: reply.author.username,
      text: reply.text,
      date: dateOnly(reply.createdAt),
      mentions: []
    }))
  }));

galleryRouter.get('/', auth, async (req, res) => {
  const ids = parseIds(req.query.ids);
  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 24, maxPageSize: 100 });
  const q = getSearchQuery(req);
  const type = req.query.type && req.query.type !== 'All' ? String(req.query.type) : undefined;
  const uploadedBy = req.query.uploadedBy ? String(req.query.uploadedBy) : undefined;

  const where: Prisma.GalleryItemWhereInput = {
    ...(ids.length ? { id: { in: ids } } : {}),
    ...(type ? { type: type === 'video' ? MediaType.video : MediaType.image } : { type: { in: [MediaType.image, MediaType.video] } }),
    ...(uploadedBy ? { uploader: { username: uploadedBy } } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { caption: { contains: q, mode: 'insensitive' } },
            { tags: { some: { tag: { contains: q, mode: 'insensitive' } } } }
          ]
        }
      : {})
  };

  const orderBy =
    req.query.sort === 'oldest'
      ? { uploadDate: 'asc' as const }
      : req.query.sort === 'title'
        ? { title: 'asc' as const }
        : { uploadDate: 'desc' as const };

  const [items, total] = await Promise.all([
    prisma.galleryItem.findMany({ where, include: { tags: true, uploader: true }, orderBy, skip, take }),
    prisma.galleryItem.count({ where })
  ]);
  return ok(res, paginated(items.map((item) => serializeGalleryItem(item)), page, pageSize, total));
});

galleryRouter.get('/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({
    where: { id: req.params.id },
    include: { tags: true, uploader: true }
  });
  if (!item) return fail(res, 404, 'Gallery item not found', 'NOT_FOUND');
  const comments = await prisma.comment.findMany({
    where: { entityType: EntityType.gallery, entityId: item.id },
    include: { author: true, replies: { include: { author: true } } },
    orderBy: { createdAt: 'asc' }
  });
  return ok(res, serializeGalleryItem(item, serializeComments(comments)));
});

galleryRouter.post('/', auth, allow(canWriteGallery), async (req, res) => {
  const parsed = gallerySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const item = await prisma.galleryItem.create({
    data: {
      type: parsed.data.type === 'video' ? MediaType.video : MediaType.image,
      title: parsed.data.title,
      thumbnail: parsed.data.thumbnail,
      videoUrl: parsed.data.videoUrl,
      caption: parsed.data.caption,
      uploadDate: parsed.data.date ? new Date(parsed.data.date) : new Date(),
      uploadedBy: req.user!.id,
      tags: { create: parsed.data.tags.map((tag) => ({ tag })) }
    },
    include: { tags: true, uploader: true }
  });
  await writeAudit(prisma, { actor: req.user!.username, action: 'gallery.create', entity: 'GalleryItem', entityId: item.id });
  return res.status(201).json({ success: true, data: serializeGalleryItem(item) });
});

galleryRouter.put('/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id }, include: { uploader: true } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const parsed = galleryUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const previousPaths = collectGalleryStoragePathSet(item);

  const updated = await prisma.$transaction(async (tx) => {
    if (parsed.data.tags) {
      await tx.galleryTag.deleteMany({ where: { galleryItemId: req.params.id } });
      await tx.galleryTag.createMany({
        data: parsed.data.tags.map((tag) => ({ galleryItemId: req.params.id, tag }))
      });
    }

    const next = await tx.galleryItem.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.type ? { type: parsed.data.type === 'video' ? MediaType.video : MediaType.image } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.thumbnail !== undefined ? { thumbnail: parsed.data.thumbnail } : {}),
        ...(parsed.data.videoUrl !== undefined ? { videoUrl: parsed.data.videoUrl } : {}),
        ...(parsed.data.caption !== undefined ? { caption: parsed.data.caption } : {}),
        ...(parsed.data.date !== undefined ? { uploadDate: new Date(parsed.data.date) } : {})
      },
      include: { tags: true, uploader: true }
    });
    await writeAudit(tx, { actor: req.user!.username, action: 'gallery.update', entity: 'GalleryItem', entityId: next.id });
    return next;
  });

  await cleanupUnreferencedStoragePaths(diffStoragePaths(previousPaths, collectGalleryStoragePathSet(updated)));
  return ok(res, serializeGalleryItem(updated));
});

galleryRouter.delete('/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const previousPaths = collectGalleryStoragePathSet(item);
  await prisma.$transaction(async (tx) => {
    await tx.comment.deleteMany({ where: { entityType: EntityType.gallery, entityId: req.params.id } });
    await tx.galleryItem.delete({ where: { id: req.params.id } });
  });
  await cleanupUnreferencedStoragePaths(previousPaths);
  await writeAudit(prisma, { actor: req.user!.username, action: 'gallery.delete', entity: 'GalleryItem', entityId: req.params.id });
  return ok(res, { deleted: true });
});

galleryRouter.post('/:id/comments', auth, async (req, res) =>
  res.status(201).json({
    success: true,
    data: await prisma.comment.create({
      data: { entityType: EntityType.gallery, entityId: req.params.id, authorId: req.user!.id, text: req.body.text }
    })
  })
);

galleryRouter.post('/:id/comments/:commentId/replies', auth, async (req, res) =>
  res.status(201).json({
    success: true,
    data: await prisma.reply.create({ data: { commentId: req.params.commentId, authorId: req.user!.id, text: req.body.text } })
  })
);

galleryRouter.put('/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.comment.update({ where: { id: comment.id }, data: { text: req.body.text } }));
});

galleryRouter.delete('/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.comment.delete({ where: { id: comment.id } }));
});

galleryRouter.put('/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId } });
  if (!reply) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.reply.update({ where: { id: reply.id }, data: { text: req.body.text } }));
});

galleryRouter.delete('/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId } });
  if (!reply) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.reply.delete({ where: { id: reply.id } }));
});
