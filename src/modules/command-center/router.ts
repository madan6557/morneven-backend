import { EntityType, ProjectStatus } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { ok } from '../../utils/response.js';
import { serializeGalleryItem, serializeLoreItem, serializeProject } from '../../utils/serializers.js';

export const commandCenterRouter = Router();

const defaultSettings = {
  showStats: true,
  showProjects: true,
  showNews: true,
  showCharacters: true,
  showPlaces: true,
  showTechnology: true,
  showGallery: true,
  showQuickActions: true,
  welcomeMessage: "Here's your operational overview.",
  itemLimits: {
    projects: 5,
    news: 6,
    characters: 3,
    places: 3,
    technology: 3,
    gallery: 4
  },
  manualSelections: {
    projects: [] as string[],
    news: [] as string[],
    characters: [] as string[],
    places: [] as string[],
    technology: [] as string[],
    gallery: [] as string[]
  }
};

const mergeSettings = (settings?: Record<string, unknown> | null) => ({
  ...defaultSettings,
  ...(settings ?? {}),
  itemLimits: {
    ...defaultSettings.itemLimits,
    ...((settings?.itemLimits as Record<string, number> | undefined) ?? {})
  },
  manualSelections: {
    ...defaultSettings.manualSelections,
    ...((settings?.manualSelections as Record<string, string[]> | undefined) ?? {})
  }
});

const inManualOrder = <T extends { id: string }>(items: T[], ids: string[]) => {
  const index = new Map(ids.map((id, i) => [id, i]));
  return items.sort((a, b) => (index.get(a.id) ?? 1e9) - (index.get(b.id) ?? 1e9));
};

commandCenterRouter.get('/', auth, async (req, res) => {
  const rawSettings = await prisma.commandCenterSettings.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  const settings = mergeSettings(rawSettings as Record<string, unknown> | null);

  const docs = await prisma.entityDoc.findMany();
  const docsByEntity = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), doc]);
  }

  const [totalProjects, activeProjects, totalLore, totalGallery] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: ProjectStatus.OnProgress } }),
    prisma.loreItem.count(),
    prisma.galleryItem.count()
  ]);

  const projects = !settings.showProjects
    ? []
    : settings.manualSelections.projects.length
      ? inManualOrder(
          (await prisma.project.findMany({
            where: { id: { in: settings.manualSelections.projects }, archived: false },
            include: { patches: true }
          })).map(serializeProject),
          settings.manualSelections.projects
        )
      : (await prisma.project.findMany({
          where: { archived: false },
          include: { patches: true },
          orderBy: { updatedAt: 'desc' },
          take: settings.itemLimits.projects
        })).map(serializeProject);

  const news = !settings.showNews
    ? []
    : settings.manualSelections.news.length
      ? inManualOrder(
          await prisma.news.findMany({ where: { id: { in: settings.manualSelections.news } } }),
          settings.manualSelections.news
        )
      : await prisma.news.findMany({ orderBy: { publishDate: 'desc' }, take: settings.itemLimits.news });

  const loadLoreSection = async (enabled: boolean, manualIds: string[], fallbackTake: number, category: EntityType) => {
    if (!enabled) return [];
    const rows = manualIds.length
      ? await prisma.loreItem.findMany({ where: { id: { in: manualIds }, category } })
      : await prisma.loreItem.findMany({ where: { category }, orderBy: { name: 'asc' }, take: fallbackTake });
    const serialized = rows.map((item) => serializeLoreItem(item, docsByEntity.get(`${item.category}:${item.id}`) ?? []));
    return manualIds.length ? inManualOrder(serialized, manualIds) : serialized;
  };

  const [characters, places, technology, gallery] = await Promise.all([
    loadLoreSection(settings.showCharacters, settings.manualSelections.characters, settings.itemLimits.characters, EntityType.character),
    loadLoreSection(settings.showPlaces, settings.manualSelections.places, settings.itemLimits.places, EntityType.place),
    loadLoreSection(settings.showTechnology, settings.manualSelections.technology, settings.itemLimits.technology, EntityType.technology),
    !settings.showGallery
      ? Promise.resolve([])
      : settings.manualSelections.gallery.length
        ? Promise.resolve(
            inManualOrder(
              (await prisma.galleryItem.findMany({
                where: { id: { in: settings.manualSelections.gallery } },
                include: { tags: true, uploader: true }
              })).map((item) => serializeGalleryItem(item)),
              settings.manualSelections.gallery
            )
          )
        : prisma.galleryItem.findMany({
            include: { tags: true, uploader: true },
            orderBy: { uploadDate: 'desc' },
            take: settings.itemLimits.gallery
          }).then((items) => items.map((item) => serializeGalleryItem(item)))
  ]);

  return ok(res, {
    settings,
    stats: { totalProjects, activeProjects, totalLore, totalGallery },
    sections: { projects, news, characters, places, technology, gallery }
  });
});
