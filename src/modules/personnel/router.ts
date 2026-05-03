import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma, Track } from '@prisma/client';
import { z } from 'zod';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { roleForLevel, serializeUser } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { ensureInstituteMembership, reconcileAutoMemberships, syncDivisionMembership } from '../chat/service.js';

export const personnelRouter = Router();

const personnelPatchSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  email: z.string().email().optional(),
  level: z.coerce.number().int().min(0).max(7).optional(),
  track: z.nativeEnum(Track).optional(),
  note: z.string().optional(),
  role: z.enum(['author', 'personel', 'guest']).optional()
});

const personnelCreateSchema = personnelPatchSchema.extend({
  username: z.string().min(3).max(30),
  email: z.string().email(),
  password: z.string().min(12).max(128).optional()
});

personnelRouter.get('/', auth, allow((u) => u.level >= 4), async (req, res) => {
  const { track, level, q } = req.query;
  const where: Prisma.UserWhereInput = {
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
  };

  const users = await prisma.user.findMany({ where, orderBy: [{ level: 'desc' }, { username: 'asc' }] });
  return ok(res, users.map(serializeUser));
});

personnelRouter.get('/:id', auth, async (req, res) => {
  if (req.user!.level < 4 && req.user!.id !== req.params.id) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  return ok(res, serializeUser(user));
});

personnelRouter.post('/', auth, allow((u) => u.level >= 6), async (req, res) => {
  const parsed = personnelCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  if ((parsed.data.level ?? 1) >= 7 && req.user!.level < 7) return fail(res, 403, 'Only PL7 can create PL7 users', 'FORBIDDEN');

  const passwordHash = await bcrypt.hash(parsed.data.password ?? 'SeedPassword123', 12);
  const level = parsed.data.level ?? 1;
  const user = await prisma.user.create({
    data: {
      username: parsed.data.username,
      email: parsed.data.email,
      passwordHash,
      role: roleForLevel(level),
      level,
      track: parsed.data.track ?? Track.executive,
      note: parsed.data.note
    }
  });
  await ensureInstituteMembership(user.username, user.level);
  await syncDivisionMembership(user.username, user.track, user.level);
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.create', entity: 'User', entityId: user.id });
  return res.status(201).json({ success: true, data: serializeUser(user) });
});

personnelRouter.put('/:id', auth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (req.user!.level < 5) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (req.user!.level < 6 && req.user!.track !== target.track) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (target.level >= 7 && req.user!.level < 7) return fail(res, 403, 'PL7 users are protected', 'FORBIDDEN');

  const parsed = personnelPatchSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const level = parsed.data.level ?? target.level;

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...parsed.data,
      role: roleForLevel(level),
      level
    }
  });
  await ensureInstituteMembership(updated.username, updated.level);
  await syncDivisionMembership(updated.username, updated.track, updated.level);
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.update', entity: 'User', entityId: updated.id });
  return ok(res, serializeUser(updated));
});

personnelRouter.patch('/bulk', auth, allow((u) => u.level >= 6), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const patch = req.body.patch ?? {};
  const updates = Array.isArray(req.body.updates) ? req.body.updates : ids.map((id: string) => ({ id, ...patch }));
  if (!updates.length) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', { fieldErrors: { ids: ['Required'] } });

  const updated = await prisma.$transaction(async (tx) => {
    const results = [];
    for (const item of updates as Array<{ id: string; level?: number; track?: Track; note?: string }>) {
      const nextLevel = item.level;
      const user = await tx.user.update({
        where: { id: item.id },
        data: {
          ...(item.level !== undefined ? { level: item.level, role: roleForLevel(item.level) } : {}),
          ...(item.track !== undefined ? { track: item.track } : {}),
          ...(item.note !== undefined ? { note: item.note } : {})
        }
      });
      await ensureInstituteMembership(user.username, user.level, tx as any);
      await syncDivisionMembership(user.username, user.track, user.level, tx as any);
      results.push(user);
      if (nextLevel !== undefined) {
        await writeAudit(tx, {
          actor: req.user!.username,
          action: 'personnel.bulk-update',
          entity: 'User',
          entityId: user.id,
          metadata: { level: nextLevel }
        });
      }
    }
    return results;
  });

  return ok(res, updated.map(serializeUser));
});

personnelRouter.delete('/:id', auth, allow((u) => u.level >= 7), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (target.level >= 7) return fail(res, 403, 'PL7 users are protected', 'FORBIDDEN');
  await prisma.user.delete({ where: { id: req.params.id } });
  await reconcileAutoMemberships();
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.delete', entity: 'User', entityId: req.params.id });
  return ok(res, { deleted: true });
});
