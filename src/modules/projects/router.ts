import { Router } from 'express';
import { EntityType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { auth, allow, canWriteProjects } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parseIds, parsePagination } from '../../utils/pagination.js';
import { projectStatusFromApi, serializeDiscussionComments, serializeProject } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { normalizeProjectMeta } from '../../utils/lore-contract.js';
import { cleanupUnreferencedStoragePaths, collectProjectStoragePathSet, diffStoragePaths } from '../../utils/storage-cleanup.js';
import { appendSyncChange } from '../sync/service.js';

export const projectsRouter = Router();

const docSchema = z.object({
  type: z.enum(['image', 'video', 'file']),
  url: z.string().optional().default(''),
  thumbnail: z.string().optional().default(''),
  caption: z.string().optional().default(''),
  date: z.string().optional()
});

const patchSchema = z.object({
  version: z.string().min(1),
  date: z.string().min(1),
  notes: z.string().min(1)
});

const projectSchema = z.object({
  title: z.string().min(1).max(150),
  status: z.union([
    z.literal('Planning'),
    z.literal('On Progress'),
    z.literal('OnProgress'),
    z.literal('On Hold'),
    z.literal('OnHold'),
    z.literal('Completed'),
    z.literal('Canceled')
  ]),
  thumbnail: z.string().optional().default(''),
  headerImage: z.string().optional(),
  shortDesc: z.string().min(1).max(500),
  fullDesc: z.string().min(1),
  patches: z.array(patchSchema).optional().default([]),
  docs: z.array(docSchema).optional().default([]),
  archived: z.boolean().optional().default(false),
  contributor: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
  features: z.array(z.record(z.unknown())).optional().default([])
});

const projectUpdateSchema = projectSchema.partial();

const buildProjectData = (
  body: z.infer<typeof projectSchema> | z.infer<typeof projectUpdateSchema>,
  existingMeta?: Prisma.JsonValue | null
) => {
  const { patches, status, ...rest } = body;
  const data: Prisma.ProjectUpdateInput = {};
  if (rest.title !== undefined) data.title = rest.title;
  if (rest.thumbnail !== undefined) data.thumbnail = rest.thumbnail;
  if (rest.shortDesc !== undefined) data.shortDesc = rest.shortDesc;
  if (rest.fullDesc !== undefined) data.fullDesc = rest.fullDesc;
  if (rest.docs !== undefined) data.docs = rest.docs as Prisma.InputJsonArray;
  if (rest.archived !== undefined) data.archived = rest.archived;
  if (rest.contributor !== undefined) data.contributor = rest.contributor;
  if (rest.meta !== undefined || rest.features !== undefined || rest.headerImage !== undefined) {
    data.meta = normalizeProjectMeta(rest.meta, rest.features, rest.headerImage, existingMeta) as Prisma.InputJsonObject;
  }
  if (status) data.status = projectStatusFromApi(status);
  return { data, patches };
};

const loadProjectDiscussionComments = async (projectId: string) =>
  prisma.comment.findMany({
    where: { entityType: EntityType.project, entityId: projectId },
    include: { author: true, replies: { include: { author: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' }
  });

const respondWithProjectDetail = async (res: Parameters<typeof ok>[0], id: string) => {
  const project = await prisma.project.findUnique({ where: { id }, include: { patches: true } });
  if (!project) return fail(res, 404, 'Project not found', 'NOT_FOUND');
  const discussions = await loadProjectDiscussionComments(id);
  return ok(res, { ...serializeProject(project), discussions: serializeDiscussionComments(discussions) });
};

projectsRouter.get('/', auth, async (req, res) => {
  const ids = parseIds(req.query.ids);
  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 24, maxPageSize: 100 });
  const q = getSearchQuery(req);
  const archived = req.query.archived === undefined ? false : String(req.query.archived) === 'true';
  const status = req.query.status ? projectStatusFromApi(String(req.query.status)) : undefined;

  const where: Prisma.ProjectWhereInput = {
    ...(ids.length ? { id: { in: ids } } : {}),
    archived,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { shortDesc: { contains: q, mode: 'insensitive' } },
            { fullDesc: { contains: q, mode: 'insensitive' } }
          ]
        }
      : {})
  };

  const orderBy =
    req.query.sort === 'title'
      ? { title: 'asc' as const }
      : req.query.sort === 'title-desc'
        ? { title: 'desc' as const }
        : { createdAt: 'desc' as const };

  const [items, total] = await Promise.all([
    prisma.project.findMany({ where, include: { patches: true }, orderBy, skip, take }),
    prisma.project.count({ where })
  ]);

  return ok(res, paginated(items.map(serializeProject), page, pageSize, total));
});

projectsRouter.get('/:id', auth, async (req, res) => {
  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.post('/', auth, allow(canWriteProjects), validateBody(projectSchema), async (req, res) => {
  const { data, patches } = buildProjectData(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        ...(data as Prisma.ProjectCreateInput),
        status: projectStatusFromApi(req.body.status),
        patches: {
          create: (patches ?? []).map((patch) => ({
            version: patch.version,
            patchDate: new Date(patch.date),
            notes: patch.notes
          }))
        }
      },
      include: { patches: true }
    });
    await appendSyncChange(tx, { entity: 'project', id: project.id, action: 'upsert', record: serializeProject(project), actorId: req.user!.id });
    await writeAudit(tx, { actor: req.user!.username, action: 'project.create', entity: 'Project', entityId: project.id });
    return project;
  });
  return res.status(201).json({ success: true, data: serializeProject(created) });
});

projectsRouter.put('/:id', auth, allow(canWriteProjects), validateBody(projectUpdateSchema), async (req, res) => {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Project not found', 'NOT_FOUND');
  const previousPaths = collectProjectStoragePathSet(existing);

  const { data, patches } = buildProjectData(req.body, existing.meta);
  const updated = await prisma.$transaction(async (tx) => {
    if (patches) {
      await tx.projectPatch.deleteMany({ where: { projectId: req.params.id } });
      await tx.projectPatch.createMany({
        data: patches.map((patch) => ({
          projectId: req.params.id,
          version: patch.version,
          patchDate: new Date(patch.date),
          notes: patch.notes
        }))
      });
    }

    const project = await tx.project.update({
      where: { id: req.params.id },
      data,
      include: { patches: true }
    });
    await appendSyncChange(tx, { entity: 'project', id: project.id, action: 'upsert', record: serializeProject(project), actorId: req.user!.id });
    await writeAudit(tx, { actor: req.user!.username, action: 'project.update', entity: 'Project', entityId: project.id });
    return project;
  });

  await cleanupUnreferencedStoragePaths(diffStoragePaths(previousPaths, collectProjectStoragePathSet(updated)));
  return respondWithProjectDetail(res, updated.id);
});

projectsRouter.post('/:id/archive', auth, allow((u) => u.level === 7 || (u.level === 6 && u.track === 'executive')), async (req, res) => {
  const project = await prisma.$transaction(async (tx) => {
    const next = await tx.project.update({ where: { id: req.params.id }, data: { archived: true }, include: { patches: true } });
    await appendSyncChange(tx, { entity: 'project', id: next.id, action: 'upsert', record: serializeProject(next), actorId: req.user!.id });
    await writeAudit(tx, { actor: req.user!.username, action: 'project.archive', entity: 'Project', entityId: next.id });
    return next;
  });
  return ok(res, serializeProject(project));
});

projectsRouter.delete('/:id', auth, allow((u) => u.level === 7), async (req, res) => {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Project not found', 'NOT_FOUND');
  const previousPaths = collectProjectStoragePathSet(existing);

  await prisma.$transaction(async (tx) => {
    await tx.comment.deleteMany({ where: { entityType: EntityType.project, entityId: req.params.id } });
    await tx.project.delete({ where: { id: req.params.id } });
    await appendSyncChange(tx, { entity: 'project', id: req.params.id, action: 'delete', record: null, actorId: req.user!.id });
    await writeAudit(tx, { actor: req.user!.username, action: 'project.delete', entity: 'Project', entityId: req.params.id });
  });
  await cleanupUnreferencedStoragePaths(previousPaths);
  return ok(res, { deleted: true });
});

projectsRouter.post('/:id/comments', auth, async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) return fail(res, 404, 'Project not found', 'NOT_FOUND');
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Comment text is required', 'VALIDATION_ERROR');

  await prisma.comment.create({
    data: {
      entityType: EntityType.project,
      entityId: req.params.id,
      authorId: req.user!.id,
      text: String(req.body.text).trim()
    }
  });

  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.post('/:id/comments/:commentId/replies', auth, async (req, res) => {
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Reply text is required', 'VALIDATION_ERROR');
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType: EntityType.project, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');

  await prisma.reply.create({
    data: { commentId: req.params.commentId, authorId: req.user!.id, text: String(req.body.text).trim() }
  });

  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.put('/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType: EntityType.project, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');
  if (comment.authorId !== req.user!.id) {
    return fail(res, 403, 'Only the comment owner can edit this discussion item', 'FORBIDDEN');
  }
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Comment text is required', 'VALIDATION_ERROR');

  await prisma.comment.update({ where: { id: comment.id }, data: { text: String(req.body.text).trim() } });
  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.delete('/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.commentId, entityType: EntityType.project, entityId: req.params.id }
  });
  if (!comment) return fail(res, 404, 'Comment not found', 'NOT_FOUND');
  if (!(req.user!.level >= 6 || comment.authorId === req.user!.id)) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  await prisma.comment.delete({ where: { id: comment.id } });
  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.put('/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId }, include: { comment: true } });
  if (
    !reply ||
    reply.comment.entityType !== EntityType.project ||
    reply.comment.entityId !== req.params.id ||
    reply.commentId !== req.params.commentId
  ) {
    return fail(res, 404, 'Reply not found', 'NOT_FOUND');
  }
  if (reply.authorId !== req.user!.id) {
    return fail(res, 403, 'Only the reply owner can edit this discussion item', 'FORBIDDEN');
  }
  if (!String(req.body.text ?? '').trim()) return fail(res, 422, 'Reply text is required', 'VALIDATION_ERROR');

  await prisma.reply.update({ where: { id: reply.id }, data: { text: String(req.body.text).trim() } });
  return respondWithProjectDetail(res, req.params.id);
});

projectsRouter.delete('/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId }, include: { comment: true } });
  if (
    !reply ||
    reply.comment.entityType !== EntityType.project ||
    reply.comment.entityId !== req.params.id ||
    reply.commentId !== req.params.commentId
  ) {
    return fail(res, 404, 'Reply not found', 'NOT_FOUND');
  }
  if (!(req.user!.level >= 6 || reply.authorId === req.user!.id)) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  await prisma.reply.delete({ where: { id: reply.id } });
  return respondWithProjectDetail(res, req.params.id);
});
