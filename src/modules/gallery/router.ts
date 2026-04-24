import { Router } from 'express';
import { EntityType, MediaType } from '@prisma/client';
import { auth, allow, canModerateDiscussion, canWriteGallery } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';

export const galleryRouter = Router();

galleryRouter.get('/', auth, async (_req, res) => ok(res, await prisma.galleryItem.findMany({ include: { tags: true } })));
galleryRouter.get('/:id', auth, async (req, res) =>
  ok(res, await prisma.galleryItem.findUnique({ where: { id: req.params.id }, include: { tags: true } }))
);
galleryRouter.post('/', auth, allow(canWriteGallery), async (req, res) => {
  const data = { ...req.body, uploadedBy: req.user!.id, type: (req.body.type ?? 'image') as MediaType };
  return res.status(201).json({ success: true, data: await prisma.galleryItem.create({ data }) });
});
galleryRouter.put('/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.galleryItem.update({ where: { id: req.params.id }, data: req.body }));
});
galleryRouter.delete('/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.galleryItem.delete({ where: { id: req.params.id } }));
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
