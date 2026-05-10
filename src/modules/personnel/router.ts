import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { serializeUser } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { ensureInstituteMembership, reconcileAutoMemberships, syncDivisionMembership } from '../chat/service.js';
import { heartbeatPresence } from '../presence/service.js';

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

const isPl7AuthorTarget = (user: { level: number; role: Role }) => user.level >= 7 && user.role === Role.author;

const resolvePersonnelRole = (level: number, requestedRole?: Role | 'author' | 'personel' | 'guest') => {
  if (level <= 0) return Role.guest;
  if (level >= 7) return requestedRole === 'author' ? Role.author : Role.personel;
  return Role.personel;
};

const highestManageableLevel = (actor: NonNullable<Express.Request['user']>) => {
  if (actor.level === 6) return 5;
  return actor.level >= 7 ? 7 : actor.level;
};

personnelRouter.get('/', auth, async (req, res) => {
  if (req.user!.level < 4) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
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

personnelRouter.get('/lookup', auth, async (req, res) => {
  const raw = String(req.query.usernames ?? '');
  const usernames = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!usernames.length) return ok(res, []);
  const users = await prisma.user.findMany({
    where: {
      OR: usernames.map((username) => ({
        username: { equals: username, mode: 'insensitive' }
      }))
    },
    select: { id: true, username: true, email: true, role: true, level: true, track: true, note: true, updatedAt: true }
  });
  const deduped = Array.from(new Map(users.map((user) => [user.username.toLowerCase(), user])).values());
  return ok(res, deduped.map(serializeUser));
});

personnelRouter.post('/presence/heartbeat', auth, async (req, res) => {
  heartbeatPresence(req.user!.username);
  return ok(res, { online: true, lastSeenAt: new Date().toISOString() });
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

  const passwordHash = await bcrypt.hash(parsed.data.password ?? 'SeedPassword123', 12);
  const level = parsed.data.level ?? 1;
  const nextRole = resolvePersonnelRole(level, parsed.data.role);

  if (level > highestManageableLevel(req.user!)) {
    return fail(res, 403, 'Cannot create personnel at or above your own clearance', 'FORBIDDEN');
  }
  if (level >= 7 && req.user!.level < 7) {
    return fail(res, 403, 'Only PL7 can create PL7 users', 'FORBIDDEN');
  }
  if (level >= 7 && req.user!.role !== Role.author && nextRole === Role.author) {
    return fail(res, 403, 'Only PL7 authors can create PL7 author accounts', 'FORBIDDEN');
  }

  const user = await prisma.user.create({
    data: {
      username: parsed.data.username,
      email: parsed.data.email,
      passwordHash,
      role: nextRole,
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
  if (req.user!.id === target.id) return fail(res, 403, 'You cannot edit your own account', 'FORBIDDEN');
  if (req.user!.level < 5) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (req.user!.level === 5 && req.user!.track !== target.track) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (isPl7AuthorTarget(target) && req.user!.level < 7) return fail(res, 403, 'PL7 author accounts are protected', 'FORBIDDEN');
  if (isPl7AuthorTarget(target) && req.user!.role !== Role.author) return fail(res, 403, 'PL7 author accounts are protected', 'FORBIDDEN');

  const parsed = personnelPatchSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const patchKeys = Object.keys(parsed.data);

  if (req.user!.level === 5) {
    if (patchKeys.some((key) => key !== 'note')) {
      return fail(res, 403, 'PL5 can only update personnel notes', 'FORBIDDEN');
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { note: parsed.data.note ?? target.note }
    });
    await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.update-note', entity: 'User', entityId: updated.id });
    return ok(res, serializeUser(updated));
  }

  const level = parsed.data.level ?? target.level;
  const role = resolvePersonnelRole(level, parsed.data.role ?? target.role);

  if (level > highestManageableLevel(req.user!)) {
    return fail(res, 403, 'Cannot raise personnel to your own clearance or higher', 'FORBIDDEN');
  }
  if (req.user!.level === 6 && target.level >= 7) {
    return fail(res, 403, 'PL7 users are protected', 'FORBIDDEN');
  }
  if (req.user!.level >= 7 && req.user!.role !== Role.author && role === Role.author) {
    return fail(res, 403, 'Only PL7 authors can assign author role', 'FORBIDDEN');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(parsed.data.username !== undefined ? { username: parsed.data.username } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.track !== undefined ? { track: parsed.data.track } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.level !== undefined ? { level } : {}),
      ...(parsed.data.level !== undefined || parsed.data.role !== undefined ? { role } : {})
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

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const item of updates as Array<{ id: string; level?: number; track?: Track; note?: string }>) {
        const target = await tx.user.findUnique({ where: { id: item.id } });
        if (!target) continue;
        if (target.id === req.user!.id) {
          throw new Error('You cannot edit your own account');
        }
        if (isPl7AuthorTarget(target)) {
          throw new Error('PL7 author accounts are protected');
        }
        if (req.user!.level === 6 && target.level >= 7) {
          throw new Error('PL7 users are protected');
        }
        if (item.level !== undefined && item.level > highestManageableLevel(req.user!)) {
          throw new Error('Cannot raise personnel to your own clearance or higher');
        }
        const nextLevel = item.level;
        const user = await tx.user.update({
          where: { id: item.id },
          data: {
            ...(item.level !== undefined ? { level: item.level, role: resolvePersonnelRole(item.level, target.role) } : {}),
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
  } catch (error) {
    return fail(
      res,
      403,
      error instanceof Error ? error.message : 'Forbidden',
      'FORBIDDEN'
    );
  }

  return ok(res, updated.map(serializeUser));
});

personnelRouter.delete('/:id', auth, allow((u) => u.level >= 7), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (target.id === req.user!.id) return fail(res, 403, 'You cannot delete your own account', 'FORBIDDEN');
  if (isPl7AuthorTarget(target)) return fail(res, 403, 'PL7 author accounts are protected', 'FORBIDDEN');
  if (req.user!.role !== Role.author && target.level >= 7 && target.role !== Role.personel) {
    return fail(res, 403, 'PL7 author accounts are protected', 'FORBIDDEN');
  }
  await prisma.user.delete({ where: { id: req.params.id } });
  await reconcileAutoMemberships();
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.delete', entity: 'User', entityId: req.params.id });
  return ok(res, { deleted: true });
});
