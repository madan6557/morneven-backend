import { prisma } from '../../config/prisma.js';
import { AuthUser } from '../../types/auth.js';

const SITE_VISIT_BUCKET_MS = 6 * 60 * 60 * 1000;

export const floorSiteVisitBucket = (date: Date) =>
  new Date(Math.floor(date.getTime() / SITE_VISIT_BUCKET_MS) * SITE_VISIT_BUCKET_MS);

export const recordSiteVisit = async (user?: AuthUser) => {
  if (!user || user.id === 'guest') return;

  const now = new Date();
  const bucketStart = floorSiteVisitBucket(now);
  const visitorKey = user.sessionId ? `session:${user.sessionId}` : `user:${user.id}`;

  await prisma.siteVisitEvent.upsert({
    where: {
      visitorKey_bucketStart: {
        visitorKey,
        bucketStart
      }
    },
    update: {
      hits: { increment: 1 },
      lastSeenAt: now
    },
    create: {
      userId: user.id,
      visitorKey,
      bucketStart,
      hits: 1,
      lastSeenAt: now
    }
  });
};
