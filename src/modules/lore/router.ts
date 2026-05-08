import { EntityType, MediaType, Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../config/prisma.js';
import { auth, canModerateDiscussion, canWriteLore } from '../../middleware/auth.js';
import { writeAudit } from '../../utils/audit.js';
import { normalizeLoreMetadata } from '../../utils/lore-contract.js';
import { getSearchQuery, paginated, parseIds, parsePagination } from '../../utils/pagination.js';
import { fail, ok } from '../../utils/response.js';
import { categoryToEntityType, serializeDiscussionComments, serializeLoreItem } from '../../utils/serializers.js';

export const loreRouter = Router();

type LoreDocInput = { type?: string; url?: string; caption?: string };

const resolveCategory = (category: string) => categoryToEntityType(category);

const loadDocs = async (items: Array<{ id: string }>) => {
  const docs = await prisma.entityDoc.findMany({ where: { entityId: { in: items.map((item) => item.id) } } });
  const grouped = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), doc]);
  }
  return grouped;
};

const loadDiscussionComments = async (entityType: EntityType, entityId: string) =>
  prisma.comment.findMany({
    where: { entityType, entityId },
    include: { author: true, replies: { include: { author: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' }
  });

const persistDocs = async (
  tx: Prisma.TransactionClient,
  entityType: EntityType,
  entityId: string,
  docs: LoreDocInput[] | undefined
) => {
  if (!docs) return;
  await tx.entityDoc.deleteMany({ where: { entityType, entityId } });
  if (!docs.length) return;
  await tx.entityDoc.createMany({
    data: docs.map((doc) => ({
      entityType,
      entityId,
      type: doc.type === 'video' ? MediaType.video : doc.type === 'file' ? MediaType.file : MediaType.image,
      url: doc.url ?? '',
      caption: doc.caption ?? ''
    }))
  });
};

const loadLoreDetail = async (entityType: EntityType, id: string) => {
  const item = await prisma.loreItem.findFirst({ where: { id, category: entityType } });
  if (!item) return null;
  const [docs, discussions] = await Promise.all([
    prisma.entityDoc.findMany({ where: { entityType, entityId: item.id } }),
    loadDiscussionComments(entityType, item.id)
  ]);
  return { item, docs, discussions };
};

const respondWithLoreDetail = async (res: Parameters<typeof ok>[0], entityType: EntityType, id: string) => {
  const detail = await loadLoreDetail(entityType, id);
  if (!detail) return fail(res, 404, 'Lore item not found', 'NOT_FOUND');
  return ok(res, serializeLoreItem(detail.item, detail.docs, detail.discussions));
};

loreRouter.get('/:category', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');

  const ids = parseIds(req.query.ids);
  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 24, maxPageSize: 100 });
  const q = getSearchQuery(req);
  const where: Prisma.LoreItemWhereInput = {
    category: entityType,
    ...(ids.length ? { id: { in: ids } } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { type: { contains: q, mode: 'insensitive' } },
            { shortDesc: { contains: q, mode: 'insensitive' } },
            { fullDesc: { contains: q, mode: 'insensitive' } }
          ]
        }
      : {})
  };
  const orderBy = req.query.sort === 'name-desc' ? { name: 'desc' as const } : { name: 'asc' as const };

  const [items, total] = await Promise.all([
    prisma.loreItem.findMany({ where, orderBy, skip, take }),
    prisma.loreItem.count({ where })
  ]);
  const docs = await loadDocs(items);

  return ok(
    res,
    paginated(
      items.map((item) => serializeLoreItem(item, docs.get(`${item.category}:${item.id}`) ?? [])),
      page,
      pageSize,
      total
    )
  );
});

loreRouter.get('/:category/:id', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.post('/:category', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const docs = Array.isArray(req.body.docs) ? (req.body.docs as LoreDocInput[]) : [];
  const name = req.body.name ?? req.body.title;
  if (!name || !req.body.shortDesc || !req.body.fullDesc) {
    return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', {
      fieldErrors: { name: ['name or title is required'], shortDesc: ['Required'], fullDesc: ['Required'] }
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const lore = await tx.loreItem.create({
      data: {
        name,
        category: entityType,
        type: req.body.type ?? req.body.category ?? req.body.classification ?? null,
        thumbnail: req.body.thumbnail ?? '',
        shortDesc: req.body.shortDesc,
        fullDesc: req.body.fullDesc,
        metadata: normalizeLoreMetadata(entityType, req.body as Record<string, unknown>) as Prisma.InputJsonObject
      }
    });

    await persistDocs(tx, entityType, lore.id, docs);
    await writeAudit(tx, { actor: req.user!.username, action: 'lore.create', entity: 'LoreItem', entityId: lore.id });
    return lore;
  });

  const entityDocs = await prisma.entityDoc.findMany({ where: { entityType, entityId: created.id } });
  return res.status(201).json({ success: true, data: serializeLoreItem(created, entityDocs) });
});

loreRouter.put('/:category/:id', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const existing = await prisma.loreItem.findFirst({ where: { id: req.params.id, category: entityType } });
  if (!existing) return fail(res, 404, 'Lore item not found', 'NOT_FOUND');
  const docs = Array.isArray(req.body.docs) ? (req.body.docs as LoreDocInput[]) : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    await persistDocs(tx, entityType, req.params.id, docs);

    const name = req.body.name ?? req.body.title;
    const item = await tx.loreItem.update({
      where: { id: req.params.id },
      data: {
        ...(name ? { name } : {}),
        ...(req.body.type || req.body.category || req.body.classification
          ? { type: req.body.type ?? req.body.category ?? req.body.classification }
          : {}),
        ...(req.body.thumbnail !== undefined ? { thumbnail: req.body.thumbnail } : {}),
        ...(req.body.shortDesc !== undefined ? { shortDesc: req.body.shortDesc } : {}),
        ...(req.body.fullDesc !== undefined ? { fullDesc: req.body.fullDesc } : {}),
        metadata: normalizeLoreMetadata(
          entityType,
          req.body as Record<string, unknown>,
          existing.metadata
        ) as Prisma.InputJsonObject
      }
    });
    await writeAudit(tx, { actor: req.user!.username, action: 'lore.update', entity: 'LoreItem', entityId: item.id });
    return item;
  });

  const detail = await loadLoreDetail(entityType, updated.id);
  return ok(res, serializeLoreItem(detail!.item, detail!.docs, detail!.discussions));
});

loreRouter.delete('/:category/:id', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  await prisma.loreItem.delete({ where: { id: req.params.id } });
  await writeAudit(prisma, { actor: req.user!.username, action: 'lore.delete', entity: 'LoreItem', entityId: req.params.id });
  return ok(res, { deleted: true });
});

loreRouter.post('/:category/:id/comments', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');

  const target = await prisma.loreItem.findFirst({ where: { id: req.params.id, category: entityType } });
  if (!target) return fail(res, 404, 'Lore item not found', 'NOT_FOUND');
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Comment text is required', 'VALIDATION_ERROR');

  await prisma.comment.create({
    data: { entityType, entityId: req.params.id, authorId: req.user!.id, text: String(req.body.text).trim() }
  });

  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.post('/:category/:id/comments/:commentId/replies', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Reply text is required', 'VALIDATION_ERROR');

  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');

  await prisma.reply.create({
    data: { commentId: req.params.commentId, authorId: req.user!.id, text: String(req.body.text).trim() }
  });

  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.put('/:category/:id/comments/:commentId', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Comment text is required', 'VALIDATION_ERROR');

  await prisma.comment.update({ where: { id: comment.id }, data: { text: String(req.body.text).trim() } });
  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.delete('/:category/:id/comments/:commentId', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');
  if (!(canModerateDiscussion(req.user!) || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  await prisma.comment.delete({ where: { id: comment.id } });
  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.put('/:category/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId }, include: { comment: true } });
  if (!reply || reply.comment.entityType !== entityType || reply.comment.entityId !== req.params.id || reply.commentId !== req.params.commentId) {
    return fail(res, 404, 'Reply not found', 'NOT_FOUND');
  }
  if (!(canModerateDiscussion(req.user!) || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Reply text is required', 'VALIDATION_ERROR');

  await prisma.reply.update({ where: { id: reply.id }, data: { text: String(req.body.text).trim() } });
  return respondWithLoreDetail(res, entityType, req.params.id);
});

loreRouter.delete('/:category/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId }, include: { comment: true } });
  if (!reply || reply.comment.entityType !== entityType || reply.comment.entityId !== req.params.id || reply.commentId !== req.params.commentId) {
    return fail(res, 404, 'Reply not found', 'NOT_FOUND');
  }
  if (!(canModerateDiscussion(req.user!) || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  await prisma.reply.delete({ where: { id: reply.id } });
  return respondWithLoreDetail(res, entityType, req.params.id);
});
