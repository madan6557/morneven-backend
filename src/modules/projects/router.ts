import { Router } from 'express';
import { ProjectStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { auth, allow, canWriteProjects } from '../../middleware/auth.js';
import { fail, ok } from '../../utils/response.js';

export const projectsRouter = Router();

projectsRouter.get('/', auth, async (_req, res) => ok(res, await prisma.project.findMany({ include: { patches: true } })));
projectsRouter.get('/:id', auth, async (req, res) => ok(res, await prisma.project.findUnique({ where: { id: req.params.id }, include: { patches: true } })));
projectsRouter.post('/', auth, allow(canWriteProjects), async (req, res) => {
  const schema = z.object({
    title: z.string(),
    status: z.nativeEnum(ProjectStatus),
    thumbnail: z.string(),
    shortDesc: z.string(),
    fullDesc: z.string()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  return res.status(201).json({ success: true, data: await prisma.project.create({ data: parsed.data }) });
});
projectsRouter.put('/:id', auth, allow(canWriteProjects), async (req, res) =>
  ok(res, await prisma.project.update({ where: { id: req.params.id }, data: req.body }))
);
projectsRouter.delete('/:id', auth, allow(canWriteProjects), async (req, res) =>
  ok(res, await prisma.project.delete({ where: { id: req.params.id } }))
);
