import { Router } from 'express';
import { MapStatus } from '@prisma/client';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';

export const mapRouter = Router();

const canWriteMap = (u: NonNullable<Express.Request['user']>) => u.level === 7 || (u.level === 6 && u.track === 'executive');

mapRouter.get('/markers', auth, async (_req, res) => ok(res, await prisma.mapMarker.findMany()));
mapRouter.put('/markers', auth, allow(canWriteMap), async (req, res) => {
  const markers = req.body.markers as Array<{
    id?: string;
    name: string;
    status: MapStatus;
    x: number;
    y: number;
    description: string;
    loreLink?: string;
  }>;
  if (!Array.isArray(markers)) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR');
  if (markers.some((marker) => marker.x < 0 || marker.x > 1 || marker.y < 0 || marker.y > 1 || !marker.name)) {
    return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR');
  }

  await prisma.$transaction(async (tx) => {
    await tx.mapMarker.deleteMany();
    await tx.mapMarker.createMany({
      data: markers.map((marker) => ({
        id: marker.id,
        name: marker.name,
        status: marker.status,
        x: marker.x,
        y: marker.y,
        description: marker.description ?? '',
        loreLink: marker.loreLink || null
      }))
    });
  });
  return ok(res, await prisma.mapMarker.findMany());
});

mapRouter.get('/image', auth, async (_req, res) => ok(res, await prisma.mapImage.findUnique({ where: { id: 'main' } })));
mapRouter.put('/image', auth, allow(canWriteMap), async (req, res) =>
  ok(
    res,
    await prisma.mapImage.upsert({
      where: { id: 'main' },
      update: { imageUrl: req.body.imageUrl },
      create: { id: 'main', imageUrl: req.body.imageUrl }
    })
  )
);
