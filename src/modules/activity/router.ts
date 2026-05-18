import { EntityType } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { getSearchQuery, paginated, parsePagination } from '../../utils/pagination.js';
import { dateOnly, entityTypeToCategory } from '../../utils/serializers.js';
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
