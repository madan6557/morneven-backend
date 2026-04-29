import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Role, Track } from '@prisma/client';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';

export const personnelRouter = Router();

personnelRouter.get('/', auth, allow((u) => u.level >= 4), async (req, res) => {
  const { track, level, q } = req.query;
  const users = await prisma.user.findMany({
    where: {
      ...(track ? { track: track as Track } : {}),
      ...(level ? { level: Number(level) } : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: String(q), mode: 'insensitive' } },
              { email: { contains: String(q), mode: 'insensitive' } }
            ]
          }
        : {})
    }
  });

  return ok(res, users);
});

personnelRouter.get('/:id', auth, async (req, res) => {
  if (req.user!.level < 4 && req.user!.id !== req.params.id) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  return ok(res, user);
});

personnelRouter.post('/', auth, allow((u) => u.level >= 6), async (req, res) => {
  const passwordHash = await bcrypt.hash(req.body.password ?? 'secret123', 10);
  const user = await prisma.user.create({
    data: {
      username: req.body.username,
      email: req.body.email,
      passwordHash,
      role: req.body.role,
      level: req.body.level,
      track: req.body.track,
      note: req.body.note
    }
  });

  return res.status(201).json({ success: true, data: user });
});

personnelRouter.put('/:id', auth, allow((u) => u.level >= 5), async (req, res) =>
  ok(res, await prisma.user.update({ where: { id: req.params.id }, data: req.body }))
);

personnelRouter.patch('/bulk', auth, allow((u) => u.level >= 6), async (req, res) => {
  const updates = req.body.updates as Array<{ id: string; level?: number; track?: Track; role?: Role; note?: string }>;
  await Promise.all(updates.map((item) => prisma.user.update({ where: { id: item.id }, data: item })));
  return ok(res, { updated: updates.length });
});

personnelRouter.delete('/:id', auth, allow((u) => u.level >= 7), async (req, res) =>
  ok(res, await prisma.user.delete({ where: { id: req.params.id } }))
);
