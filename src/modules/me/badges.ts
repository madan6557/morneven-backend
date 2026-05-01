import { Prisma, Track } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AuthUser } from '../../types/auth.js';

const canReviewManagementRequest = (
  request: { status: string; kind: string; requester: string; requesterTrack: Track; payload: Prisma.JsonValue },
  viewer: AuthUser
) => {
  if (request.status !== 'pending') return false;
  if (request.requester === viewer.username) return false;
  if (viewer.level >= 7) return true;

  const payload =
    request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
      ? (request.payload as Record<string, unknown>)
      : {};

  if (request.kind === 'executive_promotion') return viewer.level >= 6;
  if (request.kind === 'transfer') return viewer.level >= 5 && viewer.track === payload.targetTrack;
  return viewer.level >= 4 && viewer.track === request.requesterTrack;
};

export const getChatUnreadCount = async (user: AuthUser) => {
  const conversations = await prisma.chatConversation.findMany({
    where: { members: { some: { username: user.username, status: 'active' } } },
    include: { readStates: { where: { username: user.username } } }
  });

  let total = 0;
  for (const conversation of conversations) {
    const lastReadAt = conversation.readStates[0]?.lastReadAt ?? new Date(0);
    total += await prisma.chatMessage.count({
      where: {
        conversationId: conversation.id,
        author: { not: user.username },
        system: false,
        createdAt: { gt: lastReadAt }
      }
    });
  }

  return total;
};

export const getManagementPendingCount = async (user: AuthUser) => {
  if (user.level < 4) return 0;

  const requests = await prisma.managementRequest.findMany({
    where: {
      status: 'pending',
      requester: { not: user.username },
      OR:
        user.level >= 7
          ? undefined
          : [
              { requesterTrack: user.track },
              { kind: 'executive_promotion' },
              { kind: 'transfer' }
            ]
    }
  });

  return requests.filter((request) => canReviewManagementRequest(request, user)).length;
};

export const getNotificationUnreadCount = async (user: AuthUser) => {
  const directUnread = await prisma.notification.count({
    where: { recipient: user.username, read: false }
  });

  const unreadBroadcasts = await prisma.notification.count({
    where: {
      recipient: '*',
      readStates: { none: { username: user.username } }
    }
  });

  return directUnread + unreadBroadcasts;
};

export const getNavigationBadges = async (user: AuthUser) => {
  const [chatUnreadCount, managementPendingCount, notificationUnreadCount] = await Promise.all([
    getChatUnreadCount(user),
    getManagementPendingCount(user),
    getNotificationUnreadCount(user)
  ]);

  return {
    chatUnreadCount,
    managementPendingCount,
    notificationUnreadCount
  };
};

export { canReviewManagementRequest };
