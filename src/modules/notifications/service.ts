import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { emitNavigationBadgesUpdated, emitNavigationBadgesUpdatedForUsers } from '../../realtime/events.js';

type NotificationDb = {
  notification: {
    create(args: Prisma.NotificationCreateArgs): Promise<unknown>;
  };
};

export const createNotification = (
  input: {
    kind?: string;
    title: string;
    body?: string;
    recipient: string;
    sender?: string;
    link?: string;
  },
  db: NotificationDb = prisma
) =>
  db.notification.create({
    data: {
      kind: input.kind ?? 'info',
      title: input.title,
      body: input.body,
      recipient: input.recipient,
      sender: input.sender,
      link: input.link
    }
  }).then(async (notification: any) => {
    if (input.recipient === '*') {
      const users = await prisma.user.findMany({ where: { level: { gte: 1 } }, select: { username: true } });
      await emitNavigationBadgesUpdatedForUsers(users.map((user) => user.username));
    } else {
      await emitNavigationBadgesUpdated(input.recipient);
    }
    return notification;
  });
