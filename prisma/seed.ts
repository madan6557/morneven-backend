import { PrismaClient, Role, Track, ProjectStatus, EntityType, MediaType, MapStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient();
const seedDir = path.resolve(process.cwd(), 'fe-seed');

const normalizeText = (value: unknown) => String(value ?? '').trim();
const normalizeUsername = (value: unknown) => normalizeText(value).toLowerCase();
const clampLevel = (value: unknown) => {
  const num = Number(value ?? 1);
  if (Number.isNaN(num)) return 1;
  return Math.max(0, Math.min(7, Math.trunc(num)));
};

const toRole = (value: string): Role => (value === 'author' ? Role.author : value === 'guest' ? Role.guest : Role.personel);
const toTrack = (value: string): Track => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'field') return Track.field;
  if (normalized === 'mechanic') return Track.mechanic;
  if (normalized === 'logistics') return Track.logistics;
  return Track.executive;
};
const toMediaType = (value: string): MediaType => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'video') return MediaType.video;
  if (normalized === 'link') return MediaType.link;
  if (normalized === 'file') return MediaType.file;
  return MediaType.image;
};
const toEntityType = (value: string): EntityType => {
  if (value === 'characters') return EntityType.character;
  if (value === 'places') return EntityType.place;
  if (value === 'technology') return EntityType.technology;
  if (value === 'creatures') return EntityType.creature;
  if (value === 'events') return EntityType.event;
  return EntityType.other;
};
const toProjectStatus = (value: string): ProjectStatus => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'planning') return ProjectStatus.Planning;
  if (normalized === 'on hold' || normalized === 'onhold') return ProjectStatus.OnHold;
  if (normalized === 'completed') return ProjectStatus.Completed;
  if (normalized === 'canceled' || normalized === 'cancelled') return ProjectStatus.Canceled;
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
  await prisma.auditLog.deleteMany();
  await prisma.extractionJob.deleteMany();
  await prisma.chatReadState.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatConversationMember.deleteMany();
  await prisma.chatConversation.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.quotaRecord.deleteMany();
  await prisma.managementRequest.deleteMany();
  await prisma.team.deleteMany();
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
  const usedEmails = new Set<string>();
  for (const user of personnel) {
    const username = normalizeUsername(user.username);
    const email = normalizeText(user.email).toLowerCase();
    if (!username || !email) throw new Error(`Invalid user seed row: missing username/email for id=${String(user.id ?? '')}`);
    if (usersByUsername.has(username)) throw new Error(`Duplicate username in seed: ${username}`);
    if (usedEmails.has(email)) throw new Error(`Duplicate email in seed: ${email}`);
    usedEmails.add(email);

    const passwordHash = await bcrypt.hash('SeedPassword123', 10);
    const created = await prisma.user.create({
      data: {
        id: user.id,
        username,
        email,
        passwordHash,
        role: toRole(user.role),
        level: clampLevel(user.level),
        track: toTrack(user.track),
        note: user.note
      }
    });
    usersByUsername.set(created.username.toLowerCase(), created.id);
  }

  const fallbackAuthorId = usersByUsername.get('author') ?? Array.from(usersByUsername.values())[0];
  if (!fallbackAuthorId) throw new Error('No seed users available in personnel.json');

  for (const item of projects) {
    await prisma.project.create({
      data: {
        id: item.id,
        title: item.title,
        status: toProjectStatus(item.status),
        thumbnail: item.thumbnail || '',
        shortDesc: item.shortDesc,
        fullDesc: item.fullDesc,
        docs: item.docs ?? [],
        archived: Boolean(item.archived),
        contributor: normalizeText(item.contributor) || 'author',
        meta: item.meta ?? undefined,
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
        id: item.id,
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
    const uploader = usersByUsername.get(normalizeUsername(item.uploadedBy)) ?? fallbackAuthorId;
    const createdGallery = await prisma.galleryItem.create({
      data: {
        id: item.id,
        type: toMediaType(item.type),
        title: item.title,
        thumbnail: item.thumbnail || '',
        caption: item.caption,
        videoUrl: item.videoUrl || null,
        uploadDate: item.date ? new Date(item.date) : new Date(),
        uploadedBy: uploader,
        tags: { create: (item.tags ?? []).map((tag: string) => ({ tag })) }
      }
    });

    for (const comment of item.comments ?? []) {
      const commentAuthor = usersByUsername.get(normalizeUsername(comment.author)) ?? fallbackAuthorId;
      const createdComment = await prisma.comment.create({
        data: {
          id: comment.id,
          entityType: EntityType.gallery,
          entityId: createdGallery.id,
          authorId: commentAuthor,
          text: comment.text,
          createdAt: comment.date ? new Date(comment.date) : new Date()
        }
      });

      for (const reply of comment.replies ?? []) {
        const replyAuthor = usersByUsername.get(normalizeUsername(reply.author)) ?? fallbackAuthorId;
        await prisma.reply.create({
          data: {
            id: reply.id,
            commentId: createdComment.id,
            authorId: replyAuthor,
            text: reply.text,
            createdAt: reply.date ? new Date(reply.date) : new Date()
          }
        });
      }
    }
  }

  const loreGroups = [
    { category: 'characters', items: characters },
    { category: 'places', items: places },
    { category: 'technology', items: technology },
    { category: 'creatures', items: creatures },
    { category: 'other', items: other },
    { category: 'events', items: events }
  ];

  for (const group of loreGroups) {
    for (const item of group.items) {
      const createdLore = await prisma.loreItem.create({
        data: {
          id: item.id,
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
      id: m.id,
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

  await prisma.commandCenterSettings.upsert({
    where: { presetKey: 'default' },
    update: { presetName: 'Default System Preset', isActive: true, updatedBy: 'system' },
    create: {
      presetKey: 'default',
      presetName: 'Default System Preset',
      isActive: true,
      updatedBy: 'system'
    }
  });

  await prisma.team.createMany({
    data: [
      {
        id: 'team-seed-ops',
        name: 'Field Recon Alpha',
        leader: 'p.salim',
        members: ['i.stratos', 't.bremmer'],
        track: Track.field,
        cycleYear: new Date().getFullYear(),
        completed: 0
      },
      {
        id: 'team-seed-eng',
        name: 'Nexus Maintenance Cell',
        leader: 'j.huang',
        members: ['a.koval', 's.okafor'],
        track: Track.mechanic,
        cycleYear: new Date().getFullYear(),
        completed: 1
      }
    ]
  });

  await prisma.managementRequest.createMany({
    data: [
      {
        id: 'req-seed-1',
        kind: 'clearance',
        requester: 'i.stratos',
        requesterTrack: Track.field,
        requesterLevel: 1,
        payload: { targetLevel: 2 },
        reason: 'Completed trainee obligations and ready for PL2 review.',
        status: 'pending',
        createdAt: new Date('2026-04-20')
      },
      {
        id: 'req-seed-2',
        kind: 'transfer',
        requester: 'e.ravel',
        requesterTrack: Track.logistics,
        requesterLevel: 2,
        payload: { targetTrack: 'mechanic' },
        reason: 'Background in propulsion systems; better fit with ENG track.',
        status: 'pending',
        createdAt: new Date('2026-04-21')
      }
    ]
  });

  await prisma.chatConversation.create({
    data: {
      id: 'conv-institute',
      kind: 'institute',
      name: 'Institute - All Personnel',
      source: { institute: true },
      systemManaged: true,
      createdBy: 'system',
      members: {
        create: personnel
          .filter((user) => Number(user.level ?? 1) >= 1)
          .map((user) => ({
            username: String(user.username).toLowerCase(),
            role: Number(user.level ?? 1) >= 7 ? 'admin' : 'member',
            status: 'active'
          }))
      }
    }
  });

  for (const track of [Track.executive, Track.field, Track.mechanic, Track.logistics]) {
    await prisma.chatConversation.create({
      data: {
        id: `conv-div-${track}`,
        kind: 'division',
        name: `Division - ${track.toUpperCase()}`,
        source: { track },
        systemManaged: true,
        createdBy: 'system',
        members: {
          create: personnel
            .filter((user) => Number(user.level ?? 1) >= 7 || toTrack(user.track) === track)
            .map((user) => ({
              username: String(user.username).toLowerCase(),
              role: Number(user.level ?? 1) >= 7 ? 'admin' : 'member',
              status: 'active'
            }))
        }
      }
    });
  }

  const seededTeams = await prisma.team.findMany();
  const activeSeedUsernames = new Set(
    personnel.filter((user) => Number(user.level ?? 1) >= 1).map((user) => String(user.username).toLowerCase())
  );
  for (const team of seededTeams) {
    const teamMembers = Array.isArray(team.members) ? (team.members as string[]) : [];
    const activeMembers = [...new Set([team.leader, ...teamMembers])]
      .map((username) => username.toLowerCase())
      .filter((username) => activeSeedUsernames.has(username));

    await prisma.chatConversation.create({
      data: {
        id: `conv-team-${team.id}`,
        kind: 'team',
        name: `Team - ${team.name}`,
        source: { teamId: team.id },
        systemManaged: true,
        createdBy: 'system',
        members: {
          create: activeMembers.map((username) => ({
            username,
            role: 'member',
            status: 'active'
          }))
        }
      }
    });
  }

  const [userCount, projectCount, newsCount, galleryCount, loreCount, markerCount] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.news.count(),
    prisma.galleryItem.count(),
    prisma.loreItem.count(),
    prisma.mapMarker.count()
  ]);

  console.log('Seed complete', {
    expected: {
      users: personnel.length,
      projects: projects.length,
      news: news.length,
      gallery: gallery.length,
      markers: mapData.markers.length
    },
    actual: {
      users: userCount,
      projects: projectCount,
      news: newsCount,
      gallery: galleryCount,
      lore: loreCount,
      markers: markerCount
    }
  });
}

main()
  .catch((error) => {
    console.error('Seed failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
