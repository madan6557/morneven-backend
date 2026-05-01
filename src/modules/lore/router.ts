import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { auth, canWriteLore } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parseIds, parsePagination } from '../../utils/pagination.js';
import { categoryToEntityType, serializeLoreItem } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';

export const loreRouter = Router();

const resolveCategory = (category: string) => categoryToEntityType(category);

const loadDocs = async (items: Array<{ id: string; category: Prisma.EnumEntityTypeFilter | any }>) => {
  const docs = await prisma.entityDoc.findMany({ where: { entityId: { in: items.map((item) => item.id) } } });
  const grouped = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), doc]);
  }
  return grouped;
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

  const item = await prisma.loreItem.findFirst({ where: { id: req.params.id, category: entityType } });
  if (!item) return fail(res, 404, 'Lore item not found', 'NOT_FOUND');
  const docs = await prisma.entityDoc.findMany({ where: { entityType, entityId: item.id } });
  return ok(res, serializeLoreItem(item, docs));
});

loreRouter.post('/:category', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const docs = Array.isArray(req.body.docs) ? req.body.docs : [];
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
        metadata: {
          ...req.body,
          docs: undefined,
          name: undefined,
          title: undefined,
          type: undefined,
          category: undefined,
          thumbnail: undefined,
          shortDesc: undefined,
          fullDesc: undefined
        }
      }
    });

    if (docs.length) {
      await tx.entityDoc.createMany({
        data: docs.map((doc: { type?: string; url?: string; caption?: string }) => ({
          entityType,
          entityId: lore.id,
          type: doc.type === 'video' ? 'video' : doc.type === 'file' ? 'file' : 'image',
          url: doc.url ?? '',
          caption: doc.caption ?? ''
        }))
      });
    }
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
  const docs = Array.isArray(req.body.docs) ? req.body.docs : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    if (docs) {
      await tx.entityDoc.deleteMany({ where: { entityType, entityId: req.params.id } });
      await tx.entityDoc.createMany({
        data: docs.map((doc: { type?: string; url?: string; caption?: string }) => ({
          entityType,
          entityId: req.params.id,
          type: doc.type === 'video' ? 'video' : doc.type === 'file' ? 'file' : 'image',
          url: doc.url ?? '',
          caption: doc.caption ?? ''
        }))
      });
    }

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
        metadata: {
          ...req.body,
          docs: undefined,
          name: undefined,
          title: undefined,
          type: undefined,
          category: undefined,
          thumbnail: undefined,
          shortDesc: undefined,
          fullDesc: undefined
        }
      }
    });
    await writeAudit(tx, { actor: req.user!.username, action: 'lore.update', entity: 'LoreItem', entityId: item.id });
    return item;
  });

  const entityDocs = await prisma.entityDoc.findMany({ where: { entityType, entityId: updated.id } });
  return ok(res, serializeLoreItem(updated, entityDocs));
});

loreRouter.delete('/:category/:id', auth, async (req, res) => {
  const entityType = resolveCategory(req.params.category);
  if (!entityType) return fail(res, 400, 'Unsupported lore category', 'BAD_REQUEST');
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  await prisma.loreItem.delete({ where: { id: req.params.id } });
  await writeAudit(prisma, { actor: req.user!.username, action: 'lore.delete', entity: 'LoreItem', entityId: req.params.id });
  return ok(res, { deleted: true });
});
