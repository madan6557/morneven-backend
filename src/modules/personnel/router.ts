import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { AccountStatus, Prisma, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { serializeUser } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { ensureInstituteMembership, syncDivisionMembership } from '../chat/service.js';
import { heartbeatPresence } from '../presence/service.js';
import {
  PERSONNEL_REPORT_CATEGORIES,
  PERSONNEL_REPORT_STATUSES,
  REPORT_AUTO_BAN_THRESHOLD,
  REPORT_AUTO_DEMOTE_THRESHOLD,
  applyConfirmedReportDiscipline,
  canModerateAccount,
  updateAccountStatus
} from './service.js';
import { emitToMatchingClients, emitToUsers } from '../../realtime/events.js';
import { createNotification } from '../notifications/service.js';
import { roleForLevel } from '../../utils/serializers.js';

export const personnelRouter = Router();

const ROLE_ADMIN = 'admin' as Role;
const ROLE_SECURITY = 'security' as Role;

const personnelPatchSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  email: z.string().email().optional(),
  level: z.coerce.number().int().min(0).max(7).optional(),
  track: z.nativeEnum(Track).optional(),
  note: z.string().optional(),
  role: z.enum(['author', 'admin', 'security', 'personel', 'guest']).optional()
});

const personnelCreateSchema = personnelPatchSchema.extend({
  username: z.string().min(3).max(30),
  email: z.string().email(),
  password: z.string().min(12).max(128).optional()
});

const personnelStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'banned']),
  reason: z.string().trim().min(3).max(300)
});

const personnelReportCreateSchema = z.object({
  target: z.string().trim().min(1).max(120),
  category: z.enum(PERSONNEL_REPORT_CATEGORIES),
  details: z.string().trim().min(10).max(2000)
});

const personnelReportManualActions = ['none', 'suspend', 'demote', 'ban'] as const;

const personnelReportResolveSchema = z.object({
  status: z.enum(['confirmed', 'dismissed']),
  resolutionNote: z.string().trim().max(1000).optional(),
  action: z.enum(personnelReportManualActions).optional().default('none')
});

const isPl7ProtectedTarget = (user: { level: number; role: Role }) => user.level >= 7 && (user.role === Role.author || user.role === ROLE_SECURITY);

const resolvePersonnelRole = (level: number, requestedRole?: Role | 'author' | 'admin' | 'security' | 'personel' | 'guest') => {
  if (level <= 0) return Role.guest;
  if (requestedRole === 'security') return ROLE_SECURITY;
  if (level >= 7) return requestedRole === 'author' ? Role.author : ROLE_ADMIN;
  return Role.personel;
};

const highestManageableLevel = (actor: NonNullable<Express.Request['user']>) => {
  if (actor.level === 6) return 5;
  return actor.level >= 7 ? 7 : actor.level;
};

const serializePersonnelReport = (
  report: Prisma.PersonnelReportGetPayload<{
    include: {
      reporter: true;
      target: true;
      resolvedBy: true;
    };
  }>
) => ({
  id: report.id,
  category: report.category,
  details: report.details,
  status: report.status,
  resolutionAction: report.resolutionAction ?? undefined,
  resolutionNote: report.resolutionNote ?? undefined,
  createdAt: report.createdAt.toISOString(),
  updatedAt: report.updatedAt.toISOString(),
  resolvedAt: report.resolvedAt?.toISOString(),
  reporter: serializeUser(report.reporter),
  target: serializeUser(report.target),
  resolvedBy: report.resolvedBy ? serializeUser(report.resolvedBy) : undefined
});

const emitPersonnelUpdated = (user: ReturnType<typeof serializeUser>) => {
  emitToMatchingClients((viewer) => viewer.level >= 4 && viewer.username !== user.username, 'personnel.updated', { user });
  emitToUsers([user.username], 'personnel.updated', { user });
};

const emitReportChanged = (event: 'personnel.report.created' | 'personnel.report.updated', report: ReturnType<typeof serializePersonnelReport>) => {
  emitToMatchingClients(
    (viewer) =>
      (viewer.id !== report.reporter.id && viewer.id !== report.target.id)
      && canModerateAccount(viewer, report.target),
    event,
    { report }
  );
  emitToUsers([report.reporter.username, report.target.username], event, { report });
};

const resolvePersonnelTarget = async (rawTarget: string) => {
  const target = rawTarget.trim();
  return prisma.user.findFirst({
    where: {
      OR: [
        { id: target },
        { username: { equals: target, mode: 'insensitive' } },
        { email: { equals: target.toLowerCase() } }
      ]
    }
  });
};

const syncPersonnelMemberships = async (
  db: Prisma.TransactionClient | Prisma.DefaultPrismaClient,
  user: { username: string; level: number; track: Track; accountStatus: AccountStatus }
) => {
  const effectiveLevel = user.accountStatus === AccountStatus.active ? user.level : 0;
  await ensureInstituteMembership(user.username, effectiveLevel, db as any, { emit: true });
  await syncDivisionMembership(user.username, user.track, effectiveLevel, db as any, { emit: true });
};

personnelRouter.get('/', auth, async (req, res) => {
  if (req.user!.level < 4) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const { track, level, q, status } = req.query;
  const where: Prisma.UserWhereInput = {
    ...(track ? { track: track as Track } : {}),
    ...(level ? { level: Number(level) } : {}),
    ...(status ? { accountStatus: status as AccountStatus } : {}),
    ...(q
      ? {
          OR: [
            { username: { contains: String(q), mode: 'insensitive' } },
            { email: { contains: String(q), mode: 'insensitive' } },
            { note: { contains: String(q), mode: 'insensitive' } }
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
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      accountStatus: true,
      level: true,
      track: true,
      note: true,
      statusReason: true,
      updatedAt: true
    }
  });
  const deduped = Array.from(new Map(users.map((user) => [user.username.toLowerCase(), user])).values());
  return ok(res, deduped.map(serializeUser));
});

personnelRouter.post('/presence/heartbeat', auth, async (req, res) => {
  const snapshot = heartbeatPresence(req.user!.username);
  if (snapshot.changed) {
    emitToMatchingClients((viewer) => viewer.level >= 4, 'presence.updated', { username: req.user!.username, ...snapshot });
  }
  return ok(res, { online: true, lastSeenAt: new Date().toISOString() });
});

personnelRouter.get('/reports/mine', auth, async (req, res) => {
  const reports = await prisma.personnelReport.findMany({
    where: { reporterId: req.user!.id },
    include: {
      reporter: true,
      target: true,
      resolvedBy: true
    },
    orderBy: { createdAt: 'desc' }
  });
  return ok(res, reports.map(serializePersonnelReport));
});

personnelRouter.get('/reports', auth, allow((u) => u.level >= 6), async (req, res) => {
  const where: Prisma.PersonnelReportWhereInput = {
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.category ? { category: String(req.query.category) } : {}),
    ...(req.query.target
      ? {
          target: {
            username: { contains: String(req.query.target), mode: 'insensitive' }
          }
        }
      : {})
  };
  const reports = await prisma.personnelReport.findMany({
    where,
    include: {
      reporter: true,
      target: true,
      resolvedBy: true
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
  });
  return ok(
    res,
    reports
      .filter((report) => canModerateAccount(req.user!, report.target))
      .map(serializePersonnelReport)
  );
});

personnelRouter.post('/reports', auth, async (req, res) => {
  if (req.user!.level < 1) return fail(res, 403, 'Personnel access required', 'FORBIDDEN');
  const parsed = personnelReportCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const target = await resolvePersonnelTarget(parsed.data.target);
  if (!target) return fail(res, 404, 'Target personnel not found', 'NOT_FOUND');
  if (target.id === req.user!.id) return fail(res, 422, 'You cannot report yourself', 'VALIDATION_ERROR');
  if (target.role === Role.author || target.role === ROLE_SECURITY) {
    return fail(res, 403, 'Privileged accounts are outside personnel moderation scope', 'FORBIDDEN');
  }
  if (target.accountStatus === AccountStatus.deleted) return fail(res, 422, 'Deleted accounts cannot be reported', 'VALIDATION_ERROR');

  const created = await prisma.personnelReport.create({
    data: {
      reporterId: req.user!.id,
      targetUserId: target.id,
      category: parsed.data.category,
      details: parsed.data.details,
      status: PERSONNEL_REPORT_STATUSES[0]
    },
    include: {
      reporter: true,
      target: true,
      resolvedBy: true
    }
  });

  const moderators = await prisma.user.findMany({
    where: { level: { gte: 6 }, accountStatus: AccountStatus.active },
    select: { id: true, username: true, level: true, role: true }
  });
  await Promise.all(
    moderators
      .filter((moderator) => moderator.username !== req.user!.username && canModerateAccount(moderator, target))
      .map((moderator) =>
        createNotification({
          kind: 'warning',
          title: 'Personnel report filed',
          body: `${req.user!.username} reported ${target.username} for ${parsed.data.category}.`,
          recipient: moderator.username,
          sender: req.user!.username,
          link: '/settings'
        })
      )
  );
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'personnel.report.create',
    entity: 'PersonnelReport',
    entityId: created.id,
    metadata: { category: created.category, target: target.username }
  });

  const serialized = serializePersonnelReport(created);
  emitReportChanged('personnel.report.created', serialized);
  return res.status(201).json({ success: true, data: serialized });
});

personnelRouter.post('/reports/:id/resolve', auth, allow((u) => u.level >= 6), async (req, res) => {
  const parsed = personnelReportResolveSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const report = await prisma.personnelReport.findUnique({
    where: { id: req.params.id },
    include: { reporter: true, target: true, resolvedBy: true }
  });
  if (!report) return fail(res, 404, 'Report not found', 'NOT_FOUND');
  if (report.status !== 'open') return fail(res, 409, 'Report already resolved', 'CONFLICT');
  if (!canModerateAccount(req.user!, report.target)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const resolved = await prisma.$transaction(async (tx) => {
    let target = report.target;
    let resolvedAction = parsed.data.action;
    let resolutionNote = parsed.data.resolutionNote;

    if (parsed.data.status === 'confirmed') {
      if (parsed.data.action === 'ban') {
        const banned = await updateAccountStatus(tx as any, {
          ...target,
          disciplineStrikeCount: target.disciplineStrikeCount,
          disciplineTier: target.disciplineTier
        }, AccountStatus.banned, resolutionNote ?? 'Manually banned after confirmed report');
        target = await tx.user.update({
          where: { id: banned.id },
          data: {
            disciplineStrikeCount: { increment: 1 },
            disciplineTier: Math.max(target.disciplineTier, 2)
          }
        });
      } else if (parsed.data.action === 'suspend') {
        const suspended = await updateAccountStatus(tx as any, {
          ...target,
          disciplineStrikeCount: target.disciplineStrikeCount,
          disciplineTier: target.disciplineTier
        }, AccountStatus.suspended, resolutionNote ?? 'Suspended after confirmed report');
        target = await tx.user.update({
          where: { id: suspended.id },
          data: {
            disciplineStrikeCount: { increment: 1 }
          }
        });
      } else if (parsed.data.action === 'demote') {
        const nextLevel = Math.max(1, target.level - 1);
        target = await tx.user.update({
          where: { id: target.id },
          data: {
            level: nextLevel,
            role: roleForLevel(nextLevel),
            disciplineStrikeCount: { increment: 1 },
            disciplineTier: Math.max(target.disciplineTier, 1),
            statusReason: resolutionNote ?? 'Demoted after confirmed report',
            statusChangedAt: new Date()
          }
        });
        await syncPersonnelMemberships(tx, target);
      } else {
        const automatic = await applyConfirmedReportDiscipline(tx as any, {
          ...target,
          disciplineStrikeCount: target.disciplineStrikeCount,
          disciplineTier: target.disciplineTier
        }, resolutionNote ?? 'Automatic moderation threshold reached');
        target = automatic.updated;
        resolvedAction = automatic.action as typeof parsed.data.action;
        if (automatic.action === 'auto-demote') {
          resolutionNote = resolutionNote ?? `Auto-demoted after ${REPORT_AUTO_DEMOTE_THRESHOLD} confirmed reports.`;
        }
        if (automatic.action === 'auto-ban') {
          resolutionNote = resolutionNote ?? `Auto-banned after ${REPORT_AUTO_BAN_THRESHOLD} confirmed reports.`;
        }
      }
    }

    const updated = await tx.personnelReport.update({
      where: { id: report.id },
      data: {
        status: parsed.data.status,
        resolutionAction: resolvedAction,
        resolutionNote,
        resolvedById: req.user!.id,
        resolvedAt: new Date()
      },
      include: {
        reporter: true,
        target: true,
        resolvedBy: true
      }
    });

    await writeAudit(tx, {
      actor: req.user!.username,
      action: 'personnel.report.resolve',
      entity: 'PersonnelReport',
      entityId: report.id,
      metadata: { status: parsed.data.status, action: resolvedAction, target: report.target.username }
    });

    await createNotification({
      kind: 'warning',
      title: parsed.data.status === 'confirmed' ? 'Personnel report confirmed' : 'Personnel report dismissed',
      body: resolutionNote,
      recipient: report.reporter.username,
      sender: req.user!.username,
      link: '/settings'
    }, tx as any);

    return updated;
  });

  const serialized = serializePersonnelReport(resolved);
  emitPersonnelUpdated(serializeUser(resolved.target));
  emitReportChanged('personnel.report.updated', serialized);
  return ok(res, serialized);
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
  if (nextRole === ROLE_SECURITY && req.user!.level < 7) {
    return fail(res, 403, 'Only PL7 can create security accounts', 'FORBIDDEN');
  }
  if (nextRole === ROLE_SECURITY && level < 7) {
    return fail(res, 422, 'Security role requires PL7 clearance', 'VALIDATION_ERROR');
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
  const serialized = serializeUser(user);
  emitPersonnelUpdated(serialized);
  return res.status(201).json({ success: true, data: serialized });
});

personnelRouter.post('/:id/status', auth, allow((u) => u.level >= 6), async (req, res) => {
  const parsed = personnelStatusSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (!canModerateAccount(req.user!, target)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (target.accountStatus === AccountStatus.deleted) return fail(res, 409, 'Deleted accounts cannot be moderated', 'CONFLICT');

  const updated = await prisma.$transaction(async (tx) =>
    updateAccountStatus(tx as any, {
      ...target,
      disciplineStrikeCount: target.disciplineStrikeCount,
      disciplineTier: target.disciplineTier
    }, parsed.data.status as AccountStatus, parsed.data.reason)
  );

  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'personnel.status.update',
    entity: 'User',
    entityId: updated.id,
    metadata: { status: updated.accountStatus }
  });

  const serialized = serializeUser(updated);
  emitPersonnelUpdated(serialized);
  return ok(res, serialized);
});

personnelRouter.put('/:id', auth, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (req.user!.level < 5) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const parsed = personnelPatchSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const patchKeys = Object.keys(parsed.data);
  const isSelfEdit = req.user!.id === target.id;

  if (parsed.data.username !== undefined && parsed.data.username !== target.username) {
    return fail(res, 409, 'Username changes are disabled to preserve historical references', 'CONFLICT');
  }

  if (isSelfEdit) {
    if (req.user!.level < 6) {
      return fail(res, 403, 'You cannot edit your own account', 'FORBIDDEN');
    }
    if (patchKeys.some((key) => key !== 'note')) {
      return fail(res, 403, 'You can only edit your own note', 'FORBIDDEN');
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { note: parsed.data.note ?? target.note }
    });
    await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.self-update-note', entity: 'User', entityId: updated.id });
    const serialized = serializeUser(updated);
    emitPersonnelUpdated(serialized);
    return ok(res, serialized);
  }

  if (req.user!.level === 5 && req.user!.track !== target.track) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (isPl7ProtectedTarget(target) && req.user!.level < 7) return fail(res, 403, 'PL7 privileged accounts are protected', 'FORBIDDEN');
  if (isPl7ProtectedTarget(target) && req.user!.role !== Role.author && req.user!.role !== ROLE_SECURITY) {
    return fail(res, 403, 'PL7 privileged accounts are protected', 'FORBIDDEN');
  }

  if (req.user!.level === 5) {
    if (patchKeys.some((key) => key !== 'note')) {
      return fail(res, 403, 'PL5 can only update personnel notes', 'FORBIDDEN');
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { note: parsed.data.note ?? target.note }
    });
    await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.update-note', entity: 'User', entityId: updated.id });
    const serialized = serializeUser(updated);
    emitPersonnelUpdated(serialized);
    return ok(res, serialized);
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
  if (role === ROLE_SECURITY && req.user!.level < 7) {
    return fail(res, 403, 'Only PL7 can assign security role', 'FORBIDDEN');
  }
  if (role === ROLE_SECURITY && level < 7) {
    return fail(res, 422, 'Security role requires PL7 clearance', 'VALIDATION_ERROR');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.track !== undefined ? { track: parsed.data.track } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.level !== undefined ? { level } : {}),
      ...(parsed.data.level !== undefined || parsed.data.role !== undefined ? { role } : {})
    }
  });
  await syncPersonnelMemberships(prisma, updated);
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.update', entity: 'User', entityId: updated.id });
  const serialized = serializeUser(updated);
  emitPersonnelUpdated(serialized);
  return ok(res, serialized);
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
        if (isPl7ProtectedTarget(target)) {
          throw new Error('PL7 privileged accounts are protected');
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
        await syncPersonnelMemberships(tx, user);
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

  const serialized = updated.map(serializeUser);
  for (const user of serialized) emitPersonnelUpdated(user);
  return ok(res, serialized);
});

personnelRouter.delete('/:id', auth, allow((u) => u.level >= 7), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return fail(res, 404, 'Personnel not found', 'NOT_FOUND');
  if (!canModerateAccount(req.user!, target)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const archived = await prisma.$transaction(async (tx) =>
    updateAccountStatus(tx as any, {
      ...target,
      disciplineStrikeCount: target.disciplineStrikeCount,
      disciplineTier: target.disciplineTier
    }, AccountStatus.deleted, 'Deleted by personnel management')
  );
  await writeAudit(prisma, { actor: req.user!.username, action: 'personnel.delete', entity: 'User', entityId: req.params.id });
  const serialized = serializeUser(archived);
  emitPersonnelUpdated(serialized);
  return ok(res, { deleted: true, user: serialized });
});
