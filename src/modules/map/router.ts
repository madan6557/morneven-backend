import { Router } from 'express';
import { MapStatus } from '@prisma/client';
import { z } from 'zod';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';

export const mapRouter = Router();

const canWriteMap = (u: NonNullable<Express.Request['user']>) => u.level === 7 || (u.level === 6 && u.track === 'executive');
const markerSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  status: z.nativeEnum(MapStatus),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  description: z.string().optional().default(''),
  loreLink: z.string().optional().nullable()
});
const markersSchema = z.object({ markers: z.array(markerSchema) });

mapRouter.get('/markers', auth, async (_req, res) => ok(res, await prisma.mapMarker.findMany()));
mapRouter.put('/markers', auth, allow(canWriteMap), async (req, res) => {
  const parsed = markersSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  await prisma.$transaction(async (tx) => {
    await tx.mapMarker.deleteMany();
    await tx.mapMarker.createMany({
      data: parsed.data.markers.map((marker) => ({
        id: marker.id,
        name: marker.name,
        status: marker.status,
        x: marker.x,
        y: marker.y,
        description: marker.description,
        loreLink: marker.loreLink || null
      }))
    });
  });
  return ok(res, await prisma.mapMarker.findMany());
});

mapRouter.get('/image', auth, async (_req, res) => {
  const image = await prisma.mapImage.findUnique({ where: { id: 'main' } });
  const rawUrl = image?.imageUrl ?? '';
  const normalizedUrl = rawUrl.includes('placeholder.local') ? '' : rawUrl;
  return ok(res, { url: normalizedUrl });
});
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
