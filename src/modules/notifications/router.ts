import { Router } from 'express';
import { z } from 'zod';
import { auth, allow } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getNotificationUnreadCount } from '../me/badges.js';
import { emitNavigationBadgesUpdated } from '../../realtime/events.js';

export const notificationsRouter = Router();

const notificationSchema = z.object({
  kind: z.enum(['info', 'warning', 'system', 'mention', 'request']).default('info'),
  title: z.string().min(1),
  body: z.string().optional(),
  recipient: z.string().min(1),
  sender: z.string().optional(),
  link: z.string().optional()
});

notificationsRouter.get('/', auth, async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { OR: [{ recipient: req.user!.username }, { recipient: '*' }] },
    include: { readStates: { where: { username: req.user!.username } } },
    orderBy: { createdAt: 'desc' }
  });
  return ok(
    res,
    notifications.map((notification) => ({
      ...notification,
      read: notification.recipient === '*' ? notification.readStates.length > 0 : notification.read,
      readStates: undefined
    }))
  );
});

notificationsRouter.get('/unread-count', auth, async (req, res) => {
  const count = await getNotificationUnreadCount(req.user!);
  return ok(res, { count });
});

notificationsRouter.post('/', auth, allow((u) => u.level === 7), async (req, res) => {
  const parsed = notificationSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const created = await prisma.notification.create({
    data: {
      ...parsed.data,
      sender: parsed.data.sender ?? req.user!.username
    }
  });
  if (created.recipient !== '*') {
    await emitNavigationBadgesUpdated(created.recipient);
  }
  return res.status(201).json({ success: true, data: created });
});

notificationsRouter.post('/:id/read', auth, async (req, res) => {
  const notification = await prisma.notification.findFirst({
    where: { id: req.params.id, OR: [{ recipient: req.user!.username }, { recipient: '*' }] }
  });
  if (!notification) return fail(res, 404, 'Notification not found', 'NOT_FOUND');
  const updated =
    notification.recipient === '*'
      ? await prisma.notificationRead.upsert({
          where: { notificationId_username: { notificationId: notification.id, username: req.user!.username } },
          update: { readAt: new Date() },
          create: { notificationId: notification.id, username: req.user!.username }
        })
      : await prisma.notification.update({ where: { id: notification.id }, data: { read: true } });
  await emitNavigationBadgesUpdated(req.user!);
  return ok(res, updated);
});

notificationsRouter.post('/read-all', auth, async (req, res) => {
  const [direct, broadcasts] = await prisma.$transaction(async (tx) => {
    const directResult = await tx.notification.updateMany({
      where: { recipient: req.user!.username },
      data: { read: true }
    });
    const broadcastRows = await tx.notification.findMany({
      where: { recipient: '*', readStates: { none: { username: req.user!.username } } }
    });
    await Promise.all(
      broadcastRows.map((notification) =>
        tx.notificationRead.create({
          data: { notificationId: notification.id, username: req.user!.username }
        })
      )
    );
    return [directResult, broadcastRows] as const;
  });
  await emitNavigationBadgesUpdated(req.user!);
  return ok(res, { updated: direct.count + broadcasts.length });
});

notificationsRouter.delete('/', auth, async (req, res) => {
  const [direct, broadcasts] = await prisma.$transaction(async (tx) => {
    const directResult = await tx.notification.deleteMany({
      where: { recipient: req.user!.username }
    });
    const broadcastRows = await tx.notification.findMany({
      where: { recipient: '*', readStates: { none: { username: req.user!.username } } }
    });
    await Promise.all(
      broadcastRows.map((notification) =>
        tx.notificationRead.create({
          data: { notificationId: notification.id, username: req.user!.username }
        })
      )
    );
    return [directResult, broadcastRows] as const;
  });
  await emitNavigationBadgesUpdated(req.user!);
  return ok(res, { deleted: direct.count + broadcasts.length });
});
