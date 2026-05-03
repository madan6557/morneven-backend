import { ProjectStatus } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { ok } from '../../utils/response.js';

export const contentStatsRouter = Router();

contentStatsRouter.get('/', auth, async (req, res) => {
  const [totalProjects, activeProjects, totalLore, totalGallery] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: ProjectStatus.OnProgress } }),
    prisma.loreItem.count(),
    prisma.galleryItem.count()
  ]);

  return ok(res, {
    totalProjects,
    activeProjects,
    totalLore,
    totalGallery
  });
});
