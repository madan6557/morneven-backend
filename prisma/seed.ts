import { Prisma, PrismaClient, Role, Track, ProjectStatus, EntityType, MediaType, MapStatus, AccountStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeLoreMetadata, normalizeProjectMeta } from '../src/utils/lore-contract.js';

const prisma = new PrismaClient();
const passwordResetRequestModel = (prisma as any).passwordResetRequest as {
  deleteMany: () => Promise<unknown>;
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
};
const seedDir = path.resolve(process.cwd(), 'src', 'seeds');

const normalizeText = (value: unknown) => String(value ?? '').trim();
const normalizeUsername = (value: unknown) => normalizeText(value).toLowerCase();
const clampLevel = (value: unknown) => {
  const num = Number(value ?? 1);
  if (Number.isNaN(num)) return 1;
  return Math.max(0, Math.min(7, Math.trunc(num)));
};

const toRole = (value: string): Role =>
  value === 'author' ? Role.author : value === 'admin' ? Role.admin : value === 'guest' ? Role.guest : Role.personel;
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
const toAccountStatus = (value: unknown): AccountStatus => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'suspended') return AccountStatus.suspended;
  if (normalized === 'banned') return AccountStatus.banned;
  if (normalized === 'deleted') return AccountStatus.deleted;
  return AccountStatus.active;
};

async function seedDiscussionThread(
  entityType: EntityType,
  entityId: string,
  comments: any[],
  usersByUsername: Map<string, string>,
  fallbackAuthorId: string
) {
  for (const comment of comments ?? []) {
    const commentAuthor = usersByUsername.get(normalizeUsername(comment.author)) ?? fallbackAuthorId;
    const createdComment = await prisma.comment.create({
      data: {
        id: comment.id,
        entityType,
        entityId,
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

async function loadJson<T>(filename: string): Promise<T> {
  const fullPath = path.join(seedDir, filename);
  const raw = await readFile(fullPath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function loadOptionalJson<T>(filename: string, fallback: T): Promise<T> {
  try {
    return await loadJson<T>(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    throw error;
  }
}

type SeedConversationMember = {
  username: string;
  role?: 'owner' | 'admin' | 'member';
  status?: 'active' | 'invited' | 'removed';
  invitedBy?: string;
  joinedAt?: string;
};

type SeedChatMessage = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  system?: boolean;
  attachments?: Prisma.InputJsonArray;
  replyTo?: Prisma.InputJsonObject;
};

const seedMonthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const seedYearKey = (date = new Date()) => String(date.getFullYear());

async function createConversationWithMembers(args: {
  id: string;
  kind: string;
  name: string;
  createdBy: string;
  source?: Prisma.InputJsonObject;
  systemManaged?: boolean;
  createdAt?: Date;
  members: SeedConversationMember[];
}) {
  return prisma.chatConversation.create({
    data: {
      id: args.id,
      kind: args.kind,
      name: args.name,
      createdBy: args.createdBy,
      source: args.source,
      systemManaged: args.systemManaged ?? false,
      createdAt: args.createdAt,
      members: {
        create: args.members.map((member) => ({
          username: member.username.toLowerCase(),
          role: member.role ?? 'member',
          status: member.status ?? 'active',
          invitedBy: member.invitedBy?.toLowerCase(),
          joinedAt: member.joinedAt ? new Date(member.joinedAt) : args.createdAt ?? new Date()
        }))
      }
    }
  });
}

async function seedConversationMessages(conversationId: string, messages: SeedChatMessage[]) {
  for (const message of messages) {
    await prisma.chatMessage.create({
      data: {
        id: message.id,
        conversationId,
        author: message.author.toLowerCase(),
        text: message.text,
        createdAt: new Date(message.createdAt),
        system: Boolean(message.system),
        attachments: (message.attachments ?? []) as Prisma.InputJsonArray,
        replyTo: message.replyTo
      }
    });
  }
}

async function seedReadState(conversationId: string, username: string, lastReadAt: string) {
  await prisma.chatReadState.create({
    data: {
      conversationId,
      username: username.toLowerCase(),
      lastReadAt: new Date(lastReadAt)
    }
  });
}

async function main() {
  await prisma.notificationRead.deleteMany();
  await passwordResetRequestModel.deleteMany();
  await prisma.personnelReport.deleteMany();
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

  const [
    personnel,
    projects,
    news,
    gallery,
    characters,
    places,
    technology,
    creatures,
    other,
    events,
    mapData,
    passwordResetRequests,
    personnelReports
  ] = await Promise.all([
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
    loadJson<{ mapImage: string; markers: any[] }>('map.json'),
    loadOptionalJson<any[]>('password-reset-requests.json', []),
    loadOptionalJson<any[]>('personnel-reports.json', [])
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
        accountStatus: toAccountStatus(user.status ?? user.accountStatus),
        level: clampLevel(user.level),
        track: toTrack(user.track),
        note: user.note,
        statusReason: normalizeText(user.statusReason) || null
      }
    });
    usersByUsername.set(created.username.toLowerCase(), created.id);
  }

  const fallbackAuthorId = usersByUsername.get('author') ?? Array.from(usersByUsername.values())[0];
  if (!fallbackAuthorId) throw new Error('No seed users available in personnel.json');

  for (const request of passwordResetRequests) {
    const targetId =
      usersByUsername.get(normalizeUsername(request.username ?? request.targetUsername)) ??
      usersByUsername.get(normalizeUsername(request.targetUser?.username));
    if (!targetId) continue;
    const reviewedById =
      usersByUsername.get(normalizeUsername(request.reviewedBy ?? request.reviewedByUsername)) ??
      usersByUsername.get(normalizeUsername(request.reviewedBy?.username));
    const newPasswordHash =
      normalizeText(request.newPasswordHash) ||
      await bcrypt.hash(normalizeText(request.newPassword) || 'ResetAccess123', 12);

    await passwordResetRequestModel.create({
      data: {
        id: request.id,
        targetUserId: targetId,
        email: normalizeText(request.email).toLowerCase(),
        username: normalizeText(request.username) || normalizeText(request.targetUsername),
        identityProof: normalizeText(request.identityProof) || 'Seeded personnel identity proof.',
        newPasswordHash,
        status: normalizeText(request.status) || 'pending',
        reviewNote: normalizeText(request.reviewNote) || null,
        reviewedById: reviewedById ?? null,
        createdAt: request.createdAt ? new Date(request.createdAt) : new Date(),
        updatedAt: request.updatedAt ? new Date(request.updatedAt) : request.createdAt ? new Date(request.createdAt) : new Date(),
        reviewedAt: request.reviewedAt ? new Date(request.reviewedAt) : null,
        completedAt: request.completedAt ? new Date(request.completedAt) : null
      }
    });
  }

  for (const report of personnelReports) {
    const reporterId =
      usersByUsername.get(normalizeUsername(report.reporterUsername)) ??
      usersByUsername.get(normalizeUsername(report.reporter?.username)) ??
      fallbackAuthorId;
    const targetId =
      usersByUsername.get(normalizeUsername(report.targetUsername)) ??
      usersByUsername.get(normalizeUsername(report.target?.username));
    if (!targetId) continue;
    const resolvedById =
      usersByUsername.get(normalizeUsername(report.resolvedByUsername)) ??
      usersByUsername.get(normalizeUsername(report.resolvedBy?.username));

    await prisma.personnelReport.create({
      data: {
        id: report.id,
        reporterId,
        targetUserId: targetId,
        category: normalizeText(report.category) || 'other',
        details: normalizeText(report.details ?? report.reason) || 'Seeded personnel report.',
        status: normalizeText(report.status) || 'open',
        resolutionAction: normalizeText(report.resolutionAction ?? report.resolution) || null,
        resolutionNote: normalizeText(report.resolutionNote ?? report.reviewNote) || null,
        resolvedById: resolvedById ?? null,
        createdAt: report.createdAt ? new Date(report.createdAt) : new Date(),
        updatedAt: report.updatedAt ? new Date(report.updatedAt) : report.createdAt ? new Date(report.createdAt) : new Date(),
        resolvedAt: report.resolvedAt ? new Date(report.resolvedAt) : report.reviewedAt ? new Date(report.reviewedAt) : null
      }
    });
  }

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
        meta: normalizeProjectMeta(item.meta, item.features, item.headerImage) as Prisma.InputJsonValue,
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

    await seedDiscussionThread(EntityType.gallery, createdGallery.id, item.comments ?? [], usersByUsername, fallbackAuthorId);
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
          metadata: normalizeLoreMetadata(toEntityType(group.category), item) as Prisma.InputJsonValue
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

      await seedDiscussionThread(
        toEntityType(group.category),
        createdLore.id,
        item.discussions ?? [],
        usersByUsername,
        fallbackAuthorId
      );
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

  await prisma.commandCenterSettings.createMany({
    data: [
      {
        presetKey: 'intel-focus',
        presetName: 'Intel Focus',
        isActive: false,
        showStats: true,
        showProjects: false,
        showNews: true,
        showCharacters: true,
        showPlaces: true,
        showTechnology: false,
        showGallery: true,
        showQuickActions: true,
        welcomeMessage: 'Intel and field updates prioritized for this preset.',
        itemLimits: { projects: 3, news: 8, characters: 4, places: 4, technology: 2, gallery: 4 },
        manualSelections: { projects: [], news: [], characters: [], places: [], technology: [], gallery: [] },
        updatedBy: 'system'
      },
      {
        presetKey: 'archive-focus',
        presetName: 'Archive Focus',
        isActive: false,
        showStats: true,
        showProjects: true,
        showNews: false,
        showCharacters: true,
        showPlaces: false,
        showTechnology: true,
        showGallery: true,
        showQuickActions: true,
        welcomeMessage: 'Archive-heavy preset for documentation and canon browsing.',
        itemLimits: { projects: 6, news: 3, characters: 2, places: 2, technology: 6, gallery: 6 },
        manualSelections: { projects: [], news: [], characters: [], places: [], technology: [], gallery: [] },
        updatedBy: 'system'
      }
    ]
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
      },
      {
        id: 'req-seed-3',
        kind: 'submission_personal',
        requester: 't.bremmer',
        requesterTrack: Track.field,
        requesterLevel: 4,
        payload: {
          item: {
            type: 'image',
            title: 'West Ridge Survey Panel',
            thumbnail: '',
            caption: 'Field image package from the West Ridge survey corridor.',
            tags: ['field', 'survey', 'environment'],
            date: '2026-04-24',
            comments: []
          }
        },
        reason: 'Supplementary field imagery for archive intake.',
        status: 'pending',
        createdAt: new Date('2026-04-24')
      },
      {
        id: 'req-seed-4',
        kind: 'team_change',
        requester: 'p.salim',
        requesterTrack: Track.field,
        requesterLevel: 5,
        payload: {
          teamId: 'team-seed-ops',
          action: 'add',
          member: 'm.varga'
        },
        reason: 'Adding senior operative coverage for the next recon cycle.',
        status: 'pending',
        createdAt: new Date('2026-04-25')
      },
      {
        id: 'req-seed-5',
        kind: 'executive_promotion',
        requester: 'r.alves',
        requesterTrack: Track.executive,
        requesterLevel: 3,
        payload: { targetLevel: 5 },
        reason: 'Promotion packet submitted after archive operations expansion.',
        status: 'pending',
        createdAt: new Date('2026-04-26')
      },
      {
        id: 'req-seed-6',
        kind: 'submission_team',
        requester: 'j.huang',
        requesterTrack: Track.mechanic,
        requesterLevel: 4,
        payload: {
          project: {
            title: 'Nexus Cooling Retrofit',
            status: 'Planning',
            thumbnail: '',
            shortDesc: 'Retrofit plan for thermal overload mitigation in Nexus bays.',
            fullDesc: 'Approved seed example for a team project workflow.',
            docs: [],
            meta: { creator: 'j.huang', team: ['a.koval', 's.okafor'] }
          }
        },
        reason: 'Pilot proposal approved during the previous cycle.',
        status: 'approved',
        reviewer: 'author',
        reviewNote: 'Approved for pilot execution.',
        createdAt: new Date('2026-04-18'),
        decidedAt: new Date('2026-04-19')
      }
    ]
  });

  await prisma.quotaRecord.createMany({
    data: [
      {
        username: 'i.stratos',
        monthly: { [seedMonthKey()]: 1 },
        yearly: {},
        supervised: {}
      },
      {
        username: 'j.huang',
        monthly: {},
        yearly: { [seedYearKey()]: 1 },
        supervised: { [seedYearKey()]: 1 }
      },
      {
        username: 't.bremmer',
        monthly: {},
        yearly: {},
        supervised: { [seedYearKey()]: 2 }
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

  await createConversationWithMembers({
    id: 'conv-direct-author-jhuang',
    kind: 'dm',
    name: 'DM author & j.huang',
    createdBy: 'author',
    createdAt: new Date('2026-05-02T08:00:00Z'),
    members: [
      { username: 'author', role: 'owner', joinedAt: '2026-05-02T08:00:00Z' },
      { username: 'j.huang', role: 'owner', joinedAt: '2026-05-02T08:00:00Z' }
    ]
  });

  await createConversationWithMembers({
    id: 'conv-ops-sample',
    kind: 'group',
    name: 'Ops Sample Chat',
    createdBy: 'author',
    createdAt: new Date('2026-05-03T09:30:00Z'),
    members: [
      { username: 'author', role: 'owner', joinedAt: '2026-05-03T09:30:00Z' },
      { username: 'j.huang', role: 'admin', joinedAt: '2026-05-03T09:30:00Z' },
      { username: 's.okafor', role: 'member', joinedAt: '2026-05-03T09:30:00Z' },
      { username: 'e.ravel', role: 'member', status: 'invited', invitedBy: 'author', joinedAt: '2026-05-03T09:30:00Z' }
    ]
  });

  await seedConversationMessages('conv-institute', [
    {
      id: 'msg-seed-inst-1',
      author: 'system',
      text: 'Institute channel initialized for active personnel.',
      createdAt: '2026-05-01T00:00:00Z',
      system: true
    },
    {
      id: 'msg-seed-inst-2',
      author: 'm.varga',
      text: 'Outer perimeter scan complete. No hostile signatures confirmed.',
      createdAt: '2026-05-04T09:00:00Z'
    },
    {
      id: 'msg-seed-inst-3',
      author: 'author',
      text: 'Log it to field notes and route the summary to executive review.',
      createdAt: '2026-05-04T09:05:00Z'
    }
  ]);

  await seedConversationMessages('conv-div-mechanic', [
    {
      id: 'msg-seed-mech-1',
      author: 's.okafor',
      text: 'Thermal variance normalized after the last conduit swap.',
      createdAt: '2026-05-04T13:10:00Z'
    }
  ]);

  await seedConversationMessages('conv-team-team-seed-ops', [
    {
      id: 'msg-seed-team-1',
      author: 'p.salim',
      text: 'Recon team briefing uploaded. Meeting at 0600 tomorrow.',
      createdAt: '2026-05-05T06:45:00Z'
    }
  ]);

  await seedConversationMessages('conv-direct-author-jhuang', [
    {
      id: 'msg-seed-dm-1',
      author: 'j.huang',
      text: 'Morning, author. Please review field log delta-7.',
      createdAt: '2026-05-06T08:10:00Z'
    },
    {
      id: 'msg-seed-dm-2',
      author: 'author',
      text: 'Received. I will review after command briefing.',
      createdAt: '2026-05-06T08:13:00Z'
    },
    {
      id: 'msg-seed-dm-3',
      author: 'j.huang',
      text: 'One more note: thermal spikes returned in bay three.',
      createdAt: '2026-05-06T08:20:00Z'
    }
  ]);

  await seedConversationMessages('conv-ops-sample', [
    {
      id: 'msg-seed-group-1',
      author: 'author',
      text: 'Ops sample room open. Use this thread for briefing coordination.',
      createdAt: '2026-05-03T09:31:00Z'
    },
    {
      id: 'msg-seed-group-2',
      author: 's.okafor',
      text: 'Telemetry package uploaded to archive. Reviewing power drift now.',
      createdAt: '2026-05-03T09:40:00Z'
    },
    {
      id: 'msg-seed-group-3',
      author: 'j.huang',
      text: 'Unread sample message: standby for next instruction.',
      createdAt: '2026-05-03T09:55:00Z',
      replyTo: {
        messageId: 'msg-seed-group-2',
        author: 's.okafor',
        text: 'Telemetry package uploaded to archive. Reviewing power drift now.'
      }
    }
  ]);

  await seedReadState('conv-institute', 'author', '2026-05-04T09:05:00Z');
  await seedReadState('conv-div-mechanic', 'author', '2026-05-04T13:10:00Z');
  await seedReadState('conv-direct-author-jhuang', 'author', '2026-05-06T08:13:00Z');
  await seedReadState('conv-ops-sample', 'author', '2026-05-03T09:40:00Z');

  await prisma.notification.createMany({
    data: [
      {
        id: 'notif-seed-1',
        kind: 'system',
        title: 'Backend seed now powers FE sample content',
        body: 'Dummy FE content has been removed. Sample data now comes from backend seed records.',
        recipient: 'author',
        sender: 'system',
        createdAt: new Date('2026-05-06T09:00:00Z'),
        link: '/settings'
      },
      {
        id: 'notif-seed-2',
        kind: 'request',
        title: 'Management queue requires review',
        body: 'Three pending workflow requests are waiting for executive validation.',
        recipient: 'author',
        sender: 'v.kessler',
        createdAt: new Date('2026-05-06T10:00:00Z'),
        link: '/management'
      },
      {
        id: 'notif-seed-3',
        kind: 'info',
        title: 'Mechanic division patch note received',
        body: 'Cooling retrofit notes were uploaded by j.huang.',
        recipient: 's.okafor',
        sender: 'j.huang',
        createdAt: new Date('2026-05-05T11:30:00Z'),
        link: '/projects'
      },
      {
        id: 'notif-seed-4',
        kind: 'system',
        title: 'Institute bulletin',
        body: 'Quarterly archive freeze begins at 23:00 institute time.',
        recipient: '*',
        sender: 'system',
        createdAt: new Date('2026-05-05T07:00:00Z'),
        link: '/news'
      }
    ]
  });

  await prisma.notificationRead.create({
    data: {
      notificationId: 'notif-seed-4',
      username: 'j.huang',
      readAt: new Date('2026-05-05T08:00:00Z')
    }
  });

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
