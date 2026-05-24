import { AccountStatus, ContentReactionKind, EntityType } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parsePagination } from '../../utils/pagination.js';
import { dateOnly, entityTypeToCategory, serializeDiscussionComments } from '../../utils/serializers.js';
import { emptyMetric, loadContentMetrics, metricFor } from '../../utils/content-metrics.js';

export const activityRouter = Router();

const contentEntityTypes = [
  EntityType.gallery,
  EntityType.character,
  EntityType.place,
  EntityType.technology,
  EntityType.creature,
  EntityType.event,
  EntityType.other
] as const;

type ContentEntityType = (typeof contentEntityTypes)[number];
type VisitRange = '1d' | '7d' | '30d' | '90d';
type VisitBucket = 'six_hour' | 'day';

type ViewerEventRecord = {
  viewerKey: string;
  viewerKind: string;
};

type SiteVisitRecord = {
  userId: string;
  visitorKey: string;
  bucketStart: Date;
  hits: number;
  user: { username: string; accountStatus: AccountStatus };
};

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const visitRanges: VisitRange[] = ['1d', '7d', '30d', '90d'];

const visitRangeConfig: Record<VisitRange, { bucket: VisitBucket; bucketCount: number; bucketMs: number }> = {
  '1d': { bucket: 'six_hour', bucketCount: 4, bucketMs: SIX_HOURS_MS },
  '7d': { bucket: 'day', bucketCount: 7, bucketMs: DAY_MS },
  '30d': { bucket: 'day', bucketCount: 30, bucketMs: DAY_MS },
  '90d': { bucket: 'day', bucketCount: 90, bucketMs: DAY_MS }
};

const categoryLabels: Record<ContentEntityType, string> = {
  gallery: 'Gallery',
  character: 'Character',
  place: 'Place',
  technology: 'Technology',
  creature: 'Creature',
  event: 'Event',
  other: 'Other'
};

const contentUrl = (entityType: ContentEntityType, entityId: string) => {
  if (entityType === EntityType.gallery) return `/gallery/${entityId}`;
  if (entityType === EntityType.technology) return `/lore/tech/${entityId}`;
  return `/lore/${entityTypeToCategory(entityType)}/${entityId}`;
};

const parseCategory = (value: unknown): ContentEntityType | 'all' => {
  const category = String(value ?? 'all');
  if (category === 'all') return 'all';
  return contentEntityTypes.includes(category as ContentEntityType) ? (category as ContentEntityType) : 'all';
};

const parseVisitRange = (value: unknown): VisitRange => {
  const range = String(value ?? '7d');
  return visitRanges.includes(range as VisitRange) ? (range as VisitRange) : '7d';
};

const sortMetric = (value: unknown) => {
  const sort = String(value ?? 'views');
  if (['views', 'likes', 'dislikes', 'stars', 'comments', 'title', 'recent'].includes(sort)) return sort;
  return 'views';
};

const normalizeSortForCategory = (sort: string, category: ContentEntityType | 'all') => {
  if (category === EntityType.gallery && sort === 'stars') return 'views';
  if (category !== 'all' && category !== EntityType.gallery && (sort === 'likes' || sort === 'dislikes')) return 'views';
  return sort;
};

const requireRegistered = (req: Parameters<typeof auth>[0], res: Parameters<typeof fail>[0]) => {
  if (!req.user || req.user.id === 'guest') {
    fail(res, 403, 'Registered account access required', 'FORBIDDEN');
    return false;
  }
  return true;
};

const loadCommentCounts = async (keys: Array<{ entityType: EntityType; entityId: string }>) => {
  if (!keys.length) return new Map<string, number>();
  const comments = await prisma.comment.findMany({
    where: { OR: keys.map((key) => ({ entityType: key.entityType, entityId: key.entityId })) },
    select: {
      entityType: true,
      entityId: true,
      _count: { select: { replies: true } }
    }
  });
  const counts = new Map<string, number>();
  for (const comment of comments) {
    const key = `${comment.entityType}:${comment.entityId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1 + comment._count.replies);
  }
  return counts;
};

const displayUserLabel = (user?: { username: string; accountStatus: AccountStatus } | null) => {
  if (!user || user.accountStatus === AccountStatus.deleted) return 'Deleted User';
  return user.username;
};

const loadUsersForViewerEvents = async (events: ViewerEventRecord[]) => {
  const userIds = [
    ...new Set(
      events
        .map((event) => (event.viewerKey.startsWith('user:') ? event.viewerKey.slice(5) : null))
        .filter((value): value is string => Boolean(value))
    )
  ];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, accountStatus: true }
      })
    : [];
  return new Map(users.map((user) => [user.id, user]));
};

const summarizeViewerEvents = (
  events: ViewerEventRecord[],
  userById: Map<string, { username: string; accountStatus: AccountStatus }>,
  limit?: number
) => {
  const viewerMap = new Map<string, { label: string; count: number; kind: string }>();

  for (const event of events) {
    const userId = event.viewerKey.startsWith('user:') ? event.viewerKey.slice(5) : null;
    const label = userId ? displayUserLabel(userById.get(userId)) : event.viewerKind === 'guest' ? 'Guest' : 'Anonymous';
    const key = `${event.viewerKind}:${label}:${event.viewerKey}`;
    const current = viewerMap.get(key) ?? { label, count: 0, kind: event.viewerKind };
    current.count += 1;
    viewerMap.set(key, current);
  }

  const sorted = Array.from(viewerMap.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
};

const summarizeSiteVisitors = (events: SiteVisitRecord[], limit?: number) => {
  const visitorMap = new Map<string, { label: string; count: number; kind: string }>();

  for (const event of events) {
    const label = displayUserLabel(event.user);
    const current = visitorMap.get(event.userId) ?? { label, count: 0, kind: 'user' };
    current.count += 1;
    visitorMap.set(event.userId, current);
  }

  const sorted = Array.from(visitorMap.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
};

const summarizeViewers = async (entityType: EntityType, entityId: string) => {
  const events = await prisma.contentViewEvent.findMany({
    where: { entityType, entityId },
    select: { viewerKey: true, viewerKind: true },
    orderBy: { createdAt: 'desc' }
  });
  const userById = await loadUsersForViewerEvents(events);
  return summarizeViewerEvents(events, userById);
};

const floorVisitBucket = (date: Date, bucket: VisitBucket) => {
  if (bucket === 'six_hour') return new Date(Math.floor(date.getTime() / SIX_HOURS_MS) * SIX_HOURS_MS);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const addBucket = (date: Date, bucketMs: number, count: number) => new Date(date.getTime() + bucketMs * count);

const formatVisitBucketLabel = (date: Date, bucket: VisitBucket) => {
  const iso = date.toISOString();
  if (bucket === 'six_hour') return `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10);
};

const loadContentDetail = async (entityType: ContentEntityType, entityId: string) => {
  const rows = await loadContentRows(entityType, '');
  const row = rows.find((item) => item.id === entityId);
  if (!row) return null;

  const key = { entityType, entityId };
  const [metricMap, comments, reactions, viewers] = await Promise.all([
    loadContentMetrics([key]),
    prisma.comment.findMany({
      where: { entityType, entityId },
      include: { author: true, replies: { include: { author: true }, orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.contentReaction.findMany({
      where: { entityType, entityId },
      include: { user: { select: { username: true, accountStatus: true } } },
      orderBy: { createdAt: 'desc' }
    }),
    summarizeViewers(entityType, entityId)
  ]);
  const metric = metricFor(metricMap, key);
  const byKind = (kind: ContentReactionKind) =>
    reactions
      .filter((reaction) => reaction.kind === kind)
      .map((reaction) => ({
        username: displayUserLabel(reaction.user),
        date: dateOnly(reaction.createdAt)
      }));

  return {
    ...row,
    views: metric.views,
    likes: metric.likes,
    dislikes: metric.dislikes,
    stars: metric.stars,
    comments: comments.reduce((total, comment) => total + 1 + comment.replies.length, 0),
    viewers,
    likedBy: byKind(ContentReactionKind.like),
    dislikedBy: byKind(ContentReactionKind.dislike),
    starredBy: byKind(ContentReactionKind.star),
    discussion: serializeDiscussionComments(comments)
  };
};

const countDiscussionItems = async () => {
  const [comments, replies] = await Promise.all([
    prisma.comment.count({ where: { entityType: { in: [...contentEntityTypes] } } }),
    prisma.reply.count({ where: { comment: { entityType: { in: [...contentEntityTypes] } } } })
  ]);
  return comments + replies;
};

const loadContentRows = async (category: ContentEntityType | 'all', q: string) => {
  const entityTypes = category === 'all' ? contentEntityTypes : [category];
  const rows: Array<{
    id: string;
    entityType: ContentEntityType;
    category: string;
    title: string;
    thumbnail: string;
    subtitle: string;
    date: string;
    url: string;
  }> = [];

  if (entityTypes.includes(EntityType.gallery)) {
    const gallery = await prisma.galleryItem.findMany({
      where: q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { caption: { contains: q, mode: 'insensitive' } },
              { tags: { some: { tag: { contains: q, mode: 'insensitive' } } } }
            ]
          }
        : undefined,
      select: { id: true, title: true, thumbnail: true, mediaUrl: true, caption: true, uploadDate: true }
    });
    rows.push(
      ...gallery.map((item) => ({
        id: item.id,
        entityType: EntityType.gallery,
        category: categoryLabels.gallery,
        title: item.title,
        thumbnail: item.thumbnail || item.mediaUrl || '',
        subtitle: item.caption,
        date: dateOnly(item.uploadDate),
        url: contentUrl(EntityType.gallery, item.id)
      }))
    );
  }

  const loreTypes = entityTypes.filter((type) => type !== EntityType.gallery);
  if (loreTypes.length) {
    const lore = await prisma.loreItem.findMany({
      where: {
        category: { in: loreTypes },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { type: { contains: q, mode: 'insensitive' } },
                { shortDesc: { contains: q, mode: 'insensitive' } },
                { fullDesc: { contains: q, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      select: { id: true, category: true, name: true, type: true, thumbnail: true, shortDesc: true, createdAt: true }
    });
    rows.push(
      ...lore.map((item) => ({
        id: item.id,
        entityType: item.category as ContentEntityType,
        category: categoryLabels[item.category as ContentEntityType],
        title: item.name,
        thumbnail: item.thumbnail ?? '',
        subtitle: item.type ?? item.shortDesc,
        date: dateOnly(item.createdAt),
        url: contentUrl(item.category as ContentEntityType, item.id)
      }))
    );
  }

  return rows;
};

activityRouter.get('/overview', auth, async (req, res) => {
  if (!requireRegistered(req, res)) return;

  const [galleryCount, loreCount, metrics, commentCounts] = await Promise.all([
    prisma.galleryItem.count(),
    prisma.loreItem.count(),
    prisma.contentMetric.findMany({ where: { entityType: { in: [...contentEntityTypes] } } }),
    countDiscussionItems()
  ]);

  const totals = metrics.reduce(
    (acc, metric) => ({
      views: acc.views + metric.views,
      likes: acc.likes + metric.likes,
      dislikes: acc.dislikes + metric.dislikes,
      stars: acc.stars + metric.stars
    }),
    { ...emptyMetric }
  );

  const topByViews = await loadContentRows('all', '');
  const keys = topByViews.map((item) => ({ entityType: item.entityType, entityId: item.id }));
  const [metricMap, discussionMap] = await Promise.all([loadContentMetrics(keys), loadCommentCounts(keys)]);
  const leaders = topByViews
    .map((item) => {
      const key = { entityType: item.entityType, entityId: item.id };
      const metric = metricFor(metricMap, key);
      return {
        ...item,
        views: metric.views,
        likes: metric.likes,
        dislikes: metric.dislikes,
        stars: metric.stars,
        comments: discussionMap.get(`${item.entityType}:${item.id}`) ?? 0
      };
    })
    .sort((a, b) => b.views - a.views || b.stars - a.stars || b.likes - a.likes || a.title.localeCompare(b.title))
    .slice(0, 6);

  return ok(res, {
    totals: {
      content: galleryCount + loreCount,
      gallery: galleryCount,
      lore: loreCount,
      comments: commentCounts,
      ...totals
    },
    leaders
  });
});

activityRouter.get('/visits', auth, async (req, res) => {
  if (!requireRegistered(req, res)) return;

  const range = parseVisitRange(req.query.range);
  const config = visitRangeConfig[range];
  const endBucket = floorVisitBucket(new Date(), config.bucket);
  const startBucket = addBucket(endBucket, config.bucketMs, -(config.bucketCount - 1));
  const queryEnd = addBucket(endBucket, config.bucketMs, 1);

  const events = await prisma.siteVisitEvent.findMany({
    where: {
      bucketStart: { gte: startBucket, lt: queryEnd }
    },
    select: {
      userId: true,
      visitorKey: true,
      bucketStart: true,
      hits: true,
      user: {
        select: {
          username: true,
          accountStatus: true
        }
      }
    },
    orderBy: { bucketStart: 'asc' }
  });

  const buckets = Array.from({ length: config.bucketCount }, (_, index) => addBucket(startBucket, config.bucketMs, index));
  const eventsByBucket = new Map<string, typeof events>();

  for (const event of events) {
    const bucketStart = floorVisitBucket(event.bucketStart, config.bucket);
    const key = bucketStart.toISOString();
    const bucketEvents = eventsByBucket.get(key) ?? [];
    bucketEvents.push(event);
    eventsByBucket.set(key, bucketEvents);
  }

  const points = buckets.map((bucketStart) => {
    const bucketKey = bucketStart.toISOString();
    const bucketEvents = eventsByBucket.get(bucketKey) ?? [];
    const viewerSummaries = summarizeSiteVisitors(bucketEvents);
    const visitors = new Set(bucketEvents.map((event) => event.userId)).size;
    const visits = bucketEvents.length;

    return {
      bucketStart: bucketKey,
      bucketLabel: formatVisitBucketLabel(bucketStart, config.bucket),
      views: visitors,
      visitors,
      visits,
      uniqueVisitors: visitors,
      viewers: viewerSummaries.slice(0, 20),
      viewerOverflow: Math.max(0, viewerSummaries.length - 20),
      topContent: []
    };
  });

  return ok(res, {
    range,
    bucket: config.bucket,
    category: 'all',
    totalViews: points.reduce((total, point) => total + point.visitors, 0),
    totalVisitors: new Set(events.map((event) => event.userId)).size,
    totalVisits: events.length,
    uniqueVisitors: new Set(events.map((event) => event.userId)).size,
    points
  });
});

activityRouter.get('/content', auth, async (req, res) => {
  if (!requireRegistered(req, res)) return;

  const category = parseCategory(req.query.category);
  const sort = normalizeSortForCategory(sortMetric(req.query.sort), category);
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  const q = getSearchQuery(req);
  const { page, pageSize } = parsePagination(req, { pageSize: 24, maxPageSize: 100 });
  const rows = await loadContentRows(category, q);
  const keys = rows.map((item) => ({ entityType: item.entityType, entityId: item.id }));
  const [metricMap, discussionMap] = await Promise.all([loadContentMetrics(keys), loadCommentCounts(keys)]);

  const enriched = rows.map((item) => {
    const key = { entityType: item.entityType, entityId: item.id };
    const metric = metricFor(metricMap, key);
    return {
      ...item,
      views: metric.views,
      likes: metric.likes,
      dislikes: metric.dislikes,
      stars: metric.stars,
      comments: discussionMap.get(`${item.entityType}:${item.id}`) ?? 0
    };
  });

  enriched.sort((a, b) => {
    const direction = order === 'asc' ? 1 : -1;
    if (sort === 'title') return direction * a.title.localeCompare(b.title);
    if (sort === 'recent') return direction * a.date.localeCompare(b.date);
    return direction * ((a[sort as 'views' | 'likes' | 'dislikes' | 'stars' | 'comments'] ?? 0) - (b[sort as 'views' | 'likes' | 'dislikes' | 'stars' | 'comments'] ?? 0)) || a.title.localeCompare(b.title);
  });

  const start = (page - 1) * pageSize;
  return ok(res, paginated(enriched.slice(start, start + pageSize), page, pageSize, enriched.length));
});

activityRouter.get('/content/:entityType/:entityId', auth, async (req, res) => {
  if (!requireRegistered(req, res)) return;

  const entityType = contentEntityTypes.includes(req.params.entityType as ContentEntityType)
    ? (req.params.entityType as ContentEntityType)
    : null;
  if (!entityType) return fail(res, 422, 'Invalid activity content type', 'VALIDATION_ERROR');

  const detail = await loadContentDetail(entityType, req.params.entityId);
  if (!detail) return fail(res, 404, 'Activity content not found', 'NOT_FOUND');
  return ok(res, detail);
});
