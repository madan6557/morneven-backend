import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { auth, allow, canWriteProjects } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parseIds, parsePagination } from '../../utils/pagination.js';
import { projectStatusFromApi, serializeProject } from '../../utils/serializers.js';
import { writeAudit } from '../../utils/audit.js';
import { normalizeProjectMeta } from '../../utils/lore-contract.js';

export const projectsRouter = Router();

const docSchema = z.object({
  type: z.enum(['image', 'video', 'file']),
  url: z.string().optional().default(''),
  caption: z.string().optional().default('')
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
  if (rest.meta !== undefined || rest.features !== undefined) {
    data.meta = normalizeProjectMeta(rest.meta, rest.features, existingMeta) as Prisma.InputJsonObject;
  }
  if (status) data.status = projectStatusFromApi(status);
  return { data, patches };
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
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { patches: true } });
  if (!project) return fail(res, 404, 'Project not found', 'NOT_FOUND');
  return ok(res, serializeProject(project));
});

projectsRouter.post('/', auth, allow(canWriteProjects), validateBody(projectSchema), async (req, res) => {
  const { data, patches } = buildProjectData(req.body);
  const created = await prisma.project.create({
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
  await writeAudit(prisma, { actor: req.user!.username, action: 'project.create', entity: 'Project', entityId: created.id });
  return res.status(201).json({ success: true, data: serializeProject(created) });
});

projectsRouter.put('/:id', auth, allow(canWriteProjects), validateBody(projectUpdateSchema), async (req, res) => {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Project not found', 'NOT_FOUND');

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
    await writeAudit(tx, { actor: req.user!.username, action: 'project.update', entity: 'Project', entityId: project.id });
    return project;
  });

  return ok(res, serializeProject(updated));
});

projectsRouter.post('/:id/archive', auth, allow((u) => u.level === 7 || (u.level === 6 && u.track === 'executive')), async (req, res) => {
  const project = await prisma.project.update({ where: { id: req.params.id }, data: { archived: true }, include: { patches: true } });
  await writeAudit(prisma, { actor: req.user!.username, action: 'project.archive', entity: 'Project', entityId: project.id });
  return ok(res, serializeProject(project));
});

projectsRouter.delete('/:id', auth, allow((u) => u.level === 7), async (req, res) => {
  await prisma.project.delete({ where: { id: req.params.id } });
  await writeAudit(prisma, { actor: req.user!.username, action: 'project.delete', entity: 'Project', entityId: req.params.id });
  return ok(res, { deleted: true });
});
