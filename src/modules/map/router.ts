import { Router } from 'express';
import { MapStatus } from '@prisma/client';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { ok } from '../../utils/response.js';

export const mapRouter = Router();

mapRouter.get('/markers', auth, async (_req, res) => ok(res, await prisma.mapMarker.findMany()));
mapRouter.put('/markers', auth, allow((u) => u.level === 7), async (req, res) => {
  await prisma.mapMarker.deleteMany();
  await prisma.mapMarker.createMany({
    data: req.body.markers as Array<{
      name: string;
      status: MapStatus;
      x: number;
      y: number;
      description: string;
      loreLink?: string;
    }>
  });
  return ok(res, await prisma.mapMarker.findMany());
});

mapRouter.get('/image', auth, async (_req, res) => ok(res, await prisma.mapImage.findUnique({ where: { id: 'main' } })));
mapRouter.put('/image', auth, allow((u) => u.level === 7), async (req, res) =>
  ok(
    res,
    await prisma.mapImage.upsert({
      where: { id: 'main' },
      update: { imageUrl: req.body.imageUrl },
      create: { id: 'main', imageUrl: req.body.imageUrl }
    })
  )
);
