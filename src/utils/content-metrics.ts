import { ContentReactionKind, EntityType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

export type ContentMetricSummary = {
  views: number;
  likes: number;
  dislikes: number;
  stars: number;
};

export type ViewerEngagement = {
  reaction?: 'like' | 'dislike' | null;
  starred?: boolean;
};

export type ContentKey = {
  entityType: EntityType;
  entityId: string;
};

const metricId = (entityType: EntityType, entityId: string) => `metric-${entityType}-${entityId}`;
const keyOf = (key: ContentKey) => `${key.entityType}:${key.entityId}`;

export const emptyMetric: ContentMetricSummary = {
  views: 0,
  likes: 0,
  dislikes: 0,
  stars: 0
};

export const ensureContentMetric = async (
  tx: Prisma.TransactionClient,
  entityType: EntityType,
  entityId: string
) =>
  tx.contentMetric.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    update: {},
    create: { id: metricId(entityType, entityId), entityType, entityId }
  });

export const incrementContentView = async (entityType: EntityType, entityId: string) =>
  prisma.contentMetric.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    update: { views: { increment: 1 } },
    create: { id: metricId(entityType, entityId), entityType, entityId, views: 1 }
  });

export const loadContentMetrics = async (keys: ContentKey[]) => {
  if (!keys.length) return new Map<string, ContentMetricSummary>();
  const rows = await prisma.contentMetric.findMany({
    where: {
      OR: keys.map((key) => ({ entityType: key.entityType, entityId: key.entityId }))
    }
  });
  const metrics = new Map<string, ContentMetricSummary>();
  for (const row of rows) {
    metrics.set(keyOf(row), {
      views: row.views,
      likes: row.likes,
      dislikes: row.dislikes,
      stars: row.stars
    });
  }
  return metrics;
};

export const loadViewerEngagement = async (keys: ContentKey[], userId?: string) => {
  if (!keys.length || !userId) return new Map<string, ViewerEngagement>();
  const rows = await prisma.contentReaction.findMany({
    where: {
      userId,
      OR: keys.map((key) => ({ entityType: key.entityType, entityId: key.entityId }))
    }
  });
  const engagement = new Map<string, ViewerEngagement>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = engagement.get(key) ?? {};
    if (row.kind === ContentReactionKind.like) current.reaction = 'like';
    if (row.kind === ContentReactionKind.dislike) current.reaction = 'dislike';
    if (row.kind === ContentReactionKind.star) current.starred = true;
    engagement.set(key, current);
  }
  return engagement;
};

export const metricFor = (metrics: Map<string, ContentMetricSummary>, key: ContentKey) =>
  metrics.get(keyOf(key)) ?? emptyMetric;

export const engagementFor = (engagement: Map<string, ViewerEngagement>, key: ContentKey) =>
  engagement.get(keyOf(key)) ?? {};

export const setGalleryReaction = async (
  userId: string,
  entityId: string,
  reaction: 'like' | 'dislike' | null
) => {
  const entityType = EntityType.gallery;
  return prisma.$transaction(async (tx) => {
    await ensureContentMetric(tx, entityType, entityId);
    const existing = await tx.contentReaction.findMany({
      where: {
        entityType,
        entityId,
        userId,
        kind: { in: [ContentReactionKind.like, ContentReactionKind.dislike] }
      }
    });

    const hadLike = existing.some((row) => row.kind === ContentReactionKind.like);
    const hadDislike = existing.some((row) => row.kind === ContentReactionKind.dislike);
    const wantsLike = reaction === 'like';
    const wantsDislike = reaction === 'dislike';

    await tx.contentReaction.deleteMany({
      where: {
        entityType,
        entityId,
        userId,
        kind: { in: [ContentReactionKind.like, ContentReactionKind.dislike] }
      }
    });

    if (reaction) {
      await tx.contentReaction.create({
        data: {
          entityType,
          entityId,
          userId,
          kind: reaction === 'like' ? ContentReactionKind.like : ContentReactionKind.dislike
        }
      });
    }

    return tx.contentMetric.update({
      where: { entityType_entityId: { entityType, entityId } },
      data: {
        likes: { increment: (wantsLike ? 1 : 0) - (hadLike ? 1 : 0) },
        dislikes: { increment: (wantsDislike ? 1 : 0) - (hadDislike ? 1 : 0) }
      }
    });
  });
};

export const setLoreStar = async (userId: string, entityType: EntityType, entityId: string, starred: boolean) =>
  prisma.$transaction(async (tx) => {
    await ensureContentMetric(tx, entityType, entityId);
    const existing = await tx.contentReaction.findFirst({
      where: { entityType, entityId, userId, kind: ContentReactionKind.star }
    });

    if (starred && !existing) {
      await tx.contentReaction.create({
        data: { entityType, entityId, userId, kind: ContentReactionKind.star }
      });
      return tx.contentMetric.update({
        where: { entityType_entityId: { entityType, entityId } },
        data: { stars: { increment: 1 } }
      });
    }

    if (!starred && existing) {
      await tx.contentReaction.delete({ where: { id: existing.id } });
      return tx.contentMetric.update({
        where: { entityType_entityId: { entityType, entityId } },
        data: { stars: { decrement: 1 } }
      });
    }

    return tx.contentMetric.findUniqueOrThrow({ where: { entityType_entityId: { entityType, entityId } } });
  });
