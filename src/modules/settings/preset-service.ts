import { prisma } from '../../config/prisma.js';

export const defaultCommandCenterSettings = {
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
    projects: [],
    news: [],
    characters: [],
    places: [],
    technology: [],
    gallery: []
  }
};

export const ensureActiveCommandCenterPreset = async (updatedBy = 'system') => {
  const active = await prisma.commandCenterSettings.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (active) return active;

  const anyPreset = await prisma.commandCenterSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (anyPreset) {
    return prisma.commandCenterSettings.update({
      where: { id: anyPreset.id },
      data: { isActive: true, updatedBy }
    });
  }

  return prisma.commandCenterSettings.create({
    data: {
      presetKey: 'default',
      presetName: 'Default System Preset',
      isActive: true,
      updatedBy,
      ...defaultCommandCenterSettings
    }
  });
};
