import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Role, Track } from '@prisma/client';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { ok } from '../../utils/response.js';

export const personnelRouter = Router();

personnelRouter.get('/', auth, allow((u) => u.level === 7), async (_req, res) => ok(res, await prisma.user.findMany()));
personnelRouter.get('/:id', auth, allow((u) => u.level === 7), async (req, res) =>
  ok(res, await prisma.user.findUnique({ where: { id: req.params.id } }))
);
personnelRouter.post('/', auth, allow((u) => u.level === 7), async (req, res) => {
  const passwordHash = await bcrypt.hash(req.body.password ?? 'secret123', 10);
  return res.status(201).json({
    success: true,
    data: await prisma.user.create({
      data: {
        username: req.body.username,
        email: req.body.email,
        passwordHash,
        role: req.body.role,
        level: req.body.level,
        track: req.body.track,
        note: req.body.note
      }
    })
  });
});
personnelRouter.put('/:id', auth, allow((u) => u.level === 7), async (req, res) =>
  ok(res, await prisma.user.update({ where: { id: req.params.id }, data: req.body }))
);
personnelRouter.delete('/:id', auth, allow((u) => u.level === 7), async (req, res) =>
  ok(res, await prisma.user.delete({ where: { id: req.params.id } }))
);
personnelRouter.patch('/bulk', auth, allow((u) => u.level === 7), async (req, res) => {
  const updates = req.body.updates as Array<{ id: string; level?: number; track?: Track; role?: Role; note?: string }>;
  await Promise.all(updates.map((item) => prisma.user.update({ where: { id: item.id }, data: item })));
  return ok(res, { updated: updates.length });
});
