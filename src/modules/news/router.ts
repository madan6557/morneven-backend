import { Router } from 'express';
import { z } from 'zod';
import { auth, allow, canWriteNews } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { validateBody } from '../../middleware/validate.js';
import { ok } from '../../utils/response.js';

export const newsRouter = Router();

const newsSchema = z.object({
  text: z.string().min(1),
  hasDetail: z.boolean().optional().default(false),
  thumbnail: z.string().url().optional().nullable(),
  body: z.string().optional().nullable(),
  publishDate: z.string().datetime().optional()
});

const newsUpdateSchema = newsSchema.partial();

newsRouter.get('/', auth, async (_req, res) => ok(res, await prisma.news.findMany({ include: { attachments: true } })));
newsRouter.post('/', auth, allow(canWriteNews), validateBody(newsSchema), async (req, res) =>
  res.status(201).json({
    success: true,
    data: await prisma.news.create({
      data: {
        ...req.body,
        authorId: req.user!.id,
        publishDate: req.body.publishDate ? new Date(req.body.publishDate) : new Date()
      }
    })
  })
);
newsRouter.put('/:id', auth, allow(canWriteNews), validateBody(newsUpdateSchema), async (req, res) =>
  ok(res, await prisma.news.update({ where: { id: req.params.id }, data: req.body }))
);
newsRouter.delete('/:id', auth, allow(canWriteNews), async (req, res) =>
  ok(res, await prisma.news.delete({ where: { id: req.params.id } }))
);
