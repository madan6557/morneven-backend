import { Router } from 'express';
import { ProjectStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { auth, allow, canWriteProjects } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { ok } from '../../utils/response.js';

export const projectsRouter = Router();

const projectSchema = z.object({
  title: z.string().min(1).max(150),
  status: z.nativeEnum(ProjectStatus),
  thumbnail: z.string().url(),
  shortDesc: z.string().min(1).max(500),
  fullDesc: z.string().min(1)
});

const projectUpdateSchema = projectSchema.partial();

projectsRouter.get('/', auth, async (_req, res) => ok(res, await prisma.project.findMany({ include: { patches: true } })));
projectsRouter.get('/:id', auth, async (req, res) =>
  ok(res, await prisma.project.findUnique({ where: { id: req.params.id }, include: { patches: true } }))
);
projectsRouter.post('/', auth, allow(canWriteProjects), validateBody(projectSchema), async (req, res) =>
  res.status(201).json({ success: true, data: await prisma.project.create({ data: req.body }) })
);
projectsRouter.put('/:id', auth, allow(canWriteProjects), validateBody(projectUpdateSchema), async (req, res) =>
  ok(res, await prisma.project.update({ where: { id: req.params.id }, data: req.body }))
);
projectsRouter.delete('/:id', auth, allow(canWriteProjects), async (req, res) =>
  ok(res, await prisma.project.delete({ where: { id: req.params.id } }))
);
