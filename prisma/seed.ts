import { PrismaClient, Role, Track, ProjectStatus, EntityType, MediaType, MapStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient();
const seedDir = path.resolve(process.cwd(), 'fe-seed');

const toRole = (value: string): Role => (value === 'author' ? Role.author : value === 'guest' ? Role.guest : Role.personel);
const toTrack = (value: string): Track => (value === 'field' ? Track.field : value === 'mechanic' ? Track.mechanic : Track.executive);
const toMediaType = (value: string): MediaType => (value === 'video' ? MediaType.video : value === 'link' ? MediaType.link : MediaType.image);
const toEntityType = (value: string): EntityType => {
  if (value === 'characters') return EntityType.character;
  if (value === 'places') return EntityType.place;
  if (value === 'technology') return EntityType.technology;
  if (value === 'creatures') return EntityType.creature;
  return EntityType.other;
};
const toProjectStatus = (value: string): ProjectStatus => {
  if (value === 'Planning') return ProjectStatus.Planning;
  if (value === 'On Hold') return ProjectStatus.OnHold;
  if (value === 'Completed') return ProjectStatus.Completed;
  if (value === 'Canceled') return ProjectStatus.Canceled;
  return ProjectStatus.OnProgress;
};
const toMapStatus = (value: string): MapStatus => {
  if (value === 'caution') return MapStatus.caution;
  if (value === 'danger') return MapStatus.danger;
  if (value === 'restricted') return MapStatus.restricted;
  if (value === 'mission') return MapStatus.mission;
  return MapStatus.safe;
};

async function loadJson<T>(filename: string): Promise<T> {
  const fullPath = path.join(seedDir, filename);
  const raw = await readFile(fullPath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function main() {
  await prisma.mention.deleteMany();
  await prisma.reply.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.newsAttachment.deleteMany();
  await prisma.news.deleteMany();
  await prisma.projectPatch.deleteMany();
  await prisma.project.deleteMany();
  await prisma.galleryTag.deleteMany();
  await prisma.galleryItem.deleteMany();
  await prisma.entityDoc.deleteMany();
  await prisma.loreItem.deleteMany();
  await prisma.mapMarker.deleteMany();
  await prisma.mapImage.deleteMany();
  await prisma.commandCenterSettings.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const [personnel, projects, news, gallery, characters, places, technology, creatures, other, events, mapData] = await Promise.all([
    loadJson<any[]>('personnel.json'),
    loadJson<any[]>('projects.json'),
    loadJson<any[]>('news.json'),
    loadJson<any[]>('gallery.json'),
    loadJson<any[]>('characters.json'),
    loadJson<any[]>('places.json'),
    loadJson<any[]>('technology.json'),
    loadJson<any[]>('creatures.json'),
    loadJson<any[]>('other.json'),
    loadJson<any[]>('events.json'),
    loadJson<{ mapImage: string; markers: any[] }>('map.json')
  ]);

  const usersByUsername = new Map<string, string>();
  for (const user of personnel) {
    const passwordHash = await bcrypt.hash('SeedPassword123', 10);
    const created = await prisma.user.create({
      data: {
        username: String(user.username).toLowerCase(),
        email: user.email,
        passwordHash,
        role: toRole(user.role),
        level: Number(user.level ?? 1),
        track: toTrack(user.track),
        note: user.note,
        settings: { create: {} }
      }
    });
    usersByUsername.set(created.username.toLowerCase(), created.id);
  }

  const fallbackAuthorId = usersByUsername.get('author') ?? Array.from(usersByUsername.values())[0];
  if (!fallbackAuthorId) throw new Error('No seed users available in personnel.json');

  for (const item of projects) {
    await prisma.project.create({
      data: {
        title: item.title,
        status: toProjectStatus(item.status),
        thumbnail: item.thumbnail || 'https://placeholder.local/project.jpg',
        shortDesc: item.shortDesc,
        fullDesc: item.fullDesc,
        patches: {
          create: (item.patches ?? []).map((p: any) => ({
            version: p.version,
            patchDate: new Date(p.date),
            notes: p.notes
          }))
        }
      }
    });
  }

  for (const item of news) {
    await prisma.news.create({
      data: {
        authorId: fallbackAuthorId,
        text: item.text,
        publishDate: new Date(item.date),
        hasDetail: Boolean(item.hasDetail),
        thumbnail: item.thumbnail || null,
        body: item.body || null,
        attachments: {
          create: (item.attachments ?? []).map((a: any) => ({
            type: toMediaType(a.type),
            url: a.url,
            caption: a.caption || null
          }))
        }
      }
    });
  }

  for (const item of gallery) {
    const uploader = usersByUsername.get(String(item.uploadedBy).toLowerCase()) ?? fallbackAuthorId;
    await prisma.galleryItem.create({
      data: {
        type: toMediaType(item.type),
        title: item.title,
        thumbnail: item.thumbnail || 'https://placeholder.local/gallery.jpg',
        caption: item.caption,
        uploadDate: item.date ? new Date(item.date) : new Date(),
        uploadedBy: uploader,
        tags: { create: (item.tags ?? []).map((tag: string) => ({ tag })) }
      }
    });
  }

  const loreGroups = [
    { category: 'characters', items: characters },
    { category: 'places', items: places },
    { category: 'technology', items: technology },
    { category: 'creatures', items: creatures },
    { category: 'other', items: other },
    { category: 'other', items: events }
  ];

  for (const group of loreGroups) {
    for (const item of group.items) {
      const createdLore = await prisma.loreItem.create({
        data: {
          category: toEntityType(group.category),
          name: item.name ?? item.title,
          type: item.type ?? item.category ?? item.classification ?? item.era ?? null,
          thumbnail: item.thumbnail || null,
          shortDesc: item.shortDesc,
          fullDesc: item.fullDesc,
          metadata: {
            id: item.id,
            ...item,
            docs: undefined,
            shortDesc: undefined,
            fullDesc: undefined,
            name: undefined,
            title: undefined,
            type: undefined,
            category: undefined,
            thumbnail: undefined
          }
        }
      });

      for (const doc of item.docs ?? []) {
        await prisma.entityDoc.create({
          data: {
            entityType: toEntityType(group.category),
            entityId: createdLore.id,
            type: toMediaType(doc.type),
            url: doc.url || 'https://placeholder.local/doc.jpg',
            caption: doc.caption || null
          }
        });
      }
    }
  }

  await prisma.mapMarker.createMany({
    data: mapData.markers.map((m) => ({
      name: m.name,
      status: toMapStatus(m.status),
      x: Number(m.x),
      y: Number(m.y),
      description: m.description,
      loreLink: m.loreLink || null
    }))
  });

  await prisma.mapImage.create({
    data: {
      id: 'main',
      imageUrl: mapData.mapImage || 'https://placeholder.local/map.png'
    }
  });

  console.log(`Seed complete: ${personnel.length} users, ${projects.length} projects, ${news.length} news, ${gallery.length} gallery, ${mapData.markers.length} markers`);
}

main().finally(async () => {
  await prisma.$disconnect();
});
