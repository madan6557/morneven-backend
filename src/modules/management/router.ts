import { Router } from 'express';
import { AccountStatus, MediaType, Prisma, Track } from '@prisma/client';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parsePagination } from '../../utils/pagination.js';
import { projectStatusFromApi, roleForLevel } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { createNotification } from '../notifications/service.js';
import { ensureInstituteMembership, syncDivisionMembership, syncTeamGroup } from '../chat/service.js';
import { getManagementPendingCount } from '../me/badges.js';
import { emitNavigationBadgesUpdated, emitNavigationBadgesUpdatedForUsers, emitToMatchingClients } from '../../realtime/events.js';

export const managementRouter = Router();

const requestSchema = z.object({
  kind: z.enum(['transfer', 'clearance', 'submission_personal', 'submission_team', 'team_change', 'executive_promotion']),
  payload: z.record(z.unknown()).default({}),
  reason: z.string().min(1)
});

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewNote: z.string().optional()
});

const teamSchema = z.object({
  name: z.string().min(1),
  members: z.array(z.string()).min(1).max(4)
});

const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const yearKey = (date = new Date()) => String(date.getFullYear());

const asRecord = (value: Prisma.JsonValue | null | undefined): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, number>;
};

const bumpQuota = async (db: any, username: string, kind: 'monthly' | 'yearly' | 'supervised', key: string) => {
  const current = await db.quotaRecord.upsert({
    where: { username },
    update: {},
    create: { username }
  });
  const next = { ...asRecord(current[kind]), [key]: (asRecord(current[kind])[key] ?? 0) + 1 };
  await db.quotaRecord.update({ where: { username }, data: { [kind]: next } });
};

const withComputedQuota = (quota: { username: string; monthly: Prisma.JsonValue; yearly: Prisma.JsonValue; supervised: Prisma.JsonValue }) => {
  const monthly = asRecord(quota.monthly);
  const yearly = asRecord(quota.yearly);
  const supervised = asRecord(quota.supervised);
  const currentMonth = monthly[monthKey()] ?? 0;
  const currentYear = yearly[yearKey()] ?? 0;
  const supervisedYear = supervised[yearKey()] ?? 0;
  return {
    username: quota.username,
    monthly,
    yearly,
    supervised,
    pl2: { met: currentMonth >= 1, count: currentMonth },
    pl3: { met: currentYear >= 1, count: currentYear },
    pl4: { met: supervisedYear >= 2, count: supervisedYear, target: 2 }
  };
};

const canReview = (
  req: { status: string; kind: string; requester: string; requesterTrack: Track; payload: Prisma.JsonValue },
  viewer: NonNullable<Express.Request['user']>
) => {
  if (req.status !== 'pending') return false;
  if (req.requester === viewer.username) return false;
  if (viewer.level >= 7) return true;
  const payload = req.payload && typeof req.payload === 'object' && !Array.isArray(req.payload) ? (req.payload as Record<string, unknown>) : {};

  if (req.kind === 'executive_promotion') return viewer.level >= 6;
  if (req.kind === 'transfer') return viewer.level >= 5 && viewer.track === payload.targetTrack;
  return viewer.level >= 4 && viewer.track === req.requesterTrack;
};

const visibleRequestWhere = (user: NonNullable<Express.Request['user']>): Prisma.ManagementRequestWhereInput => {
  if (user.level >= 7) return {};
  if (user.level >= 4) {
    return {
      OR: [
        { requester: user.username },
        { requesterTrack: user.track },
        { kind: 'executive_promotion', requesterTrack: user.track },
        { kind: 'transfer', payload: { path: ['targetTrack'], equals: user.track } }
      ]
    };
  }
  return { requester: user.username };
};

managementRouter.get('/requests', auth, async (req, res) => {
  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 50, maxPageSize: 100 });
  const q = getSearchQuery(req);
  const andWhere: Prisma.ManagementRequestWhereInput[] = [visibleRequestWhere(req.user!)];
  if (req.query.kind) andWhere.push({ kind: String(req.query.kind) });
  if (req.query.status) andWhere.push({ status: String(req.query.status) });
  if (req.query.requester) andWhere.push({ requester: String(req.query.requester) });
  if (q) {
    andWhere.push({
      OR: [
        { requester: { contains: q, mode: 'insensitive' } },
        { reason: { contains: q, mode: 'insensitive' } }
      ]
    });
  }
  const where: Prisma.ManagementRequestWhereInput = { AND: andWhere };

  const [items, total] = await Promise.all([
    prisma.managementRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.managementRequest.count({ where })
  ]);
  return ok(res, paginated(items, page, pageSize, total));
});

managementRouter.get('/requests/pending-count', auth, async (req, res) => {
  if (req.user!.level < 1) return fail(res, 403, 'Personnel access required', 'FORBIDDEN');
  return ok(res, { count: await getManagementPendingCount(req.user!) });
});

managementRouter.post('/requests', auth, async (req, res) => {
  if (req.user!.level < 1) return fail(res, 403, 'Personnel access required', 'FORBIDDEN');
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const created = await prisma.managementRequest.create({
    data: {
      kind: parsed.data.kind,
      requester: req.user!.username,
      requesterTrack: req.user!.track,
      requesterLevel: req.user!.level,
      payload: parsed.data.payload as Prisma.InputJsonObject,
      reason: parsed.data.reason,
      status: 'pending'
    }
  });
  await writeAudit(prisma, { actor: req.user!.username, action: 'mgmt.request.create', entity: 'ManagementRequest', entityId: created.id });
  const reviewers = await prisma.user.findMany({
    where: { level: { gte: 4 }, accountStatus: AccountStatus.active },
    select: { username: true }
  });
  await emitNavigationBadgesUpdatedForUsers(reviewers.map((user) => user.username));
  emitToMatchingClients((viewer) => viewer.level >= 1, 'management.updated', { entity: 'request', id: created.id, action: 'created' });
  return res.status(201).json({ success: true, data: created });
});

managementRouter.post('/requests/:id/decide', auth, async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const request = await prisma.managementRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return fail(res, 404, 'Request not found', 'NOT_FOUND');
  if (!canReview(request, req.user!)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const decided = await prisma.$transaction(async (tx) => {
    const updated = await tx.managementRequest.update({
      where: { id: request.id },
      data: {
        status: parsed.data.decision,
        reviewer: req.user!.username,
        reviewNote: parsed.data.reviewNote,
        decidedAt: new Date()
      }
    });

    if (parsed.data.decision === 'rejected') {
      await createNotification(
        {
          kind: 'request',
          title: 'Request rejected',
          body: parsed.data.reviewNote,
          recipient: request.requester,
          sender: req.user!.username,
          link: '/management'
        },
        tx as any
      );
      return updated;
    }

    const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
      ? (request.payload as Record<string, unknown>)
      : {};
    const requester = await tx.user.findUnique({ where: { username: request.requester } });
    if (!requester) return updated;

    if (request.kind === 'transfer') {
      const targetTrack = payload.targetTrack as Track;
      await tx.user.update({ where: { id: requester.id }, data: { track: targetTrack } });
      await syncDivisionMembership(requester.username, targetTrack, requester.level, tx as any);
    }

    if (request.kind === 'clearance') {
      const targetLevel = Number(payload.targetLevel);
      await tx.user.update({ where: { id: requester.id }, data: { level: targetLevel, role: roleForLevel(targetLevel) } });
      await ensureInstituteMembership(requester.username, targetLevel, tx as any);
      await syncDivisionMembership(requester.username, requester.track, targetLevel, tx as any);
    }

    if (request.kind === 'submission_personal') {
      const item = (payload.item ?? {}) as Record<string, any>;
      await tx.galleryItem.create({
        data: {
          type: item.type === 'video' ? MediaType.video : MediaType.image,
          title: String(item.title ?? 'Untitled submission'),
          thumbnail: String(item.thumbnail ?? ''),
          caption: String(item.caption ?? ''),
          videoUrl: item.videoUrl ? String(item.videoUrl) : null,
          uploadDate: item.date ? new Date(String(item.date)) : new Date(),
          uploadedBy: requester.id,
          tags: { create: Array.isArray(item.tags) ? item.tags.map((tag: string) => ({ tag })) : [] }
        }
      });
      await bumpQuota(tx, requester.username, 'monthly', monthKey());
    }

    if (request.kind === 'submission_team') {
      const project = (payload.project ?? {}) as Record<string, any>;
      await tx.project.create({
        data: {
          title: String(project.title ?? 'Untitled project'),
          status: projectStatusFromApi(project.status ?? 'Planning'),
          thumbnail: String(project.thumbnail ?? ''),
          shortDesc: String(project.shortDesc ?? project.caption ?? ''),
          fullDesc: String(project.fullDesc ?? project.description ?? project.caption ?? ''),
          docs: Array.isArray(project.docs) ? project.docs : [],
          contributor: requester.username,
          meta: project.meta ?? undefined
        }
      });
      await bumpQuota(tx, requester.username, 'yearly', yearKey());
      await bumpQuota(tx, req.user!.username, 'supervised', yearKey());
    }

    if (request.kind === 'team_change') {
      const teamId = String(payload.teamId ?? '');
      const member = String(payload.member ?? '');
      const action = payload.action === 'remove' ? 'remove' : 'add';
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (team) {
        const members = Array.isArray(team.members) ? (team.members as string[]) : [];
        const nextMembers = action === 'add' ? [...new Set([...members, member])] : members.filter((item) => item !== member);
        await tx.team.update({ where: { id: team.id }, data: { members: nextMembers } });
        await syncTeamGroup(team.id, team.name, [team.leader, ...nextMembers], tx as any);
      }
    }

    if (request.kind === 'executive_promotion') {
      await tx.user.update({ where: { id: requester.id }, data: { level: 5, role: roleForLevel(5) } });
      await ensureInstituteMembership(requester.username, 5, tx as any);
      await syncDivisionMembership(requester.username, requester.track, 5, tx as any);
    }

    await createNotification(
      {
        kind: 'request',
        title: 'Request approved',
        recipient: request.requester,
        sender: req.user!.username,
        link: '/management'
      },
      tx as any
    );
    await writeAudit(tx, {
      actor: req.user!.username,
      action: 'mgmt.request.decide',
      entity: 'ManagementRequest',
      entityId: request.id,
      metadata: { decision: parsed.data.decision }
    });
    return updated;
  });

  await emitNavigationBadgesUpdated(req.user!);
  await emitNavigationBadgesUpdated(request.requester);
  emitToMatchingClients((viewer) => viewer.level >= 1, 'management.updated', { entity: 'request', id: request.id, action: 'updated' });
  return ok(res, decided);
});

managementRouter.get('/teams', auth, async (req, res) => {
  if (req.user!.level < 1) return fail(res, 403, 'Personnel access required', 'FORBIDDEN');
  const where: Prisma.TeamWhereInput =
    req.user!.level >= 4 ? {} : { OR: [{ leader: req.user!.username }, { members: { array_contains: req.user!.username } }] };
  const teams = await prisma.team.findMany({ where, orderBy: { createdAt: 'desc' } });
  return ok(res, teams);
});

managementRouter.post('/teams', auth, async (req, res) => {
  if (req.user!.level < 3) return fail(res, 403, 'PL3 access required', 'FORBIDDEN');
  const parsed = teamSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const members = [...new Set(parsed.data.members.filter((member) => member !== req.user!.username))];
  const sameTrackMembers = await prisma.user.findMany({
    where: {
      username: { in: members },
      track: req.user!.track,
      level: { gte: 1 },
      accountStatus: AccountStatus.active
    }
  });
  if (sameTrackMembers.length !== members.length) {
    return fail(res, 422, 'All team members must be active personnel in the same track', 'VALIDATION_ERROR');
  }

  const team = await prisma.team.create({
    data: {
      name: parsed.data.name,
      leader: req.user!.username,
      members,
      track: req.user!.track,
      cycleYear: new Date().getFullYear()
    }
  });
  await syncTeamGroup(team.id, team.name, [team.leader, ...members]);
  await writeAudit(prisma, { actor: req.user!.username, action: 'mgmt.team.create', entity: 'Team', entityId: team.id });
  await emitNavigationBadgesUpdated(req.user!);
  emitToMatchingClients((viewer) => viewer.level >= 1, 'management.updated', { entity: 'team', id: team.id, action: 'created' });
  return res.status(201).json({ success: true, data: team });
});

managementRouter.get('/quotas/:username', auth, async (req, res) => {
  if (req.user!.username !== req.params.username && req.user!.level < 4) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const quota = await prisma.quotaRecord.upsert({
    where: { username: req.params.username },
    update: {},
    create: { username: req.params.username }
  });
  return ok(res, withComputedQuota(quota));
});
