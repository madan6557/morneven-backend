import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { ok } from '../../utils/response.js';

export const settingsRouter = Router();

settingsRouter.get('/command-center', auth, async (req, res) =>
  ok(res, await prisma.commandCenterSettings.findUnique({ where: { userId: req.user!.id } }))
);
settingsRouter.put('/command-center', auth, async (req, res) =>
  ok(
    res,
    await prisma.commandCenterSettings.upsert({
      where: { userId: req.user!.id },
      update: req.body,
      create: { userId: req.user!.id, ...req.body }
    })
  )
);
