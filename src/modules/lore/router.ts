import { Router } from 'express';
import { EntityType } from '@prisma/client';
import { auth, canWriteLore } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';

export const loreRouter = Router();

const toEntityType = (category: string) => category.slice(0, -1) as EntityType;

loreRouter.get('/:category', auth, async (req, res) =>
  ok(res, await prisma.loreItem.findMany({ where: { category: toEntityType(req.params.category) } }))
);
loreRouter.get('/:category/:id', auth, async (req, res) => ok(res, await prisma.loreItem.findUnique({ where: { id: req.params.id } })));
loreRouter.post('/:category', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return res.status(201).json({
    success: true,
    data: await prisma.loreItem.create({ data: { ...req.body, category: toEntityType(req.params.category) } })
  });
});
loreRouter.put('/:category/:id', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.loreItem.update({ where: { id: req.params.id }, data: req.body }));
});
loreRouter.delete('/:category/:id', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.loreItem.delete({ where: { id: req.params.id } }));
});
