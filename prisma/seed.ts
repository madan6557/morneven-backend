import { PrismaClient, Role, Track, ProjectStatus, EntityType, MediaType, MapStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

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

  const adminPass = await bcrypt.hash('AdminSecret123', 10);
  const execPass = await bcrypt.hash('ExecutiveSecret123', 10);

  const admin = await prisma.user.create({
    data: {
      username: 'admin-l7',
      email: 'admin@morneven.com',
      passwordHash: adminPass,
      role: Role.author,
      level: 7,
      track: Track.executive,
      note: 'Seed super admin',
      settings: { create: { showStats: true, showProjects: true, showNews: true, welcomeMessage: 'Welcome Commander', itemLimits: { projects: 6, news: 8 }, manualSelections: { pinProject: true } } }
    }
  });

  const mechanic = await prisma.user.create({
    data: {
      username: 'mech-l6',
      email: 'mechanic@morneven.com',
      passwordHash: execPass,
      role: Role.personel,
      level: 6,
      track: Track.mechanic,
      note: 'Seed mechanic editor',
      settings: { create: {} }
    }
  });

  const project = await prisma.project.create({
    data: {
      title: 'Skywall Retrofit',
      status: ProjectStatus.OnProgress,
      thumbnail: 'https://placeholder.local/skywall.jpg',
      shortDesc: 'Modernisasi skywall sektor utara',
      fullDesc: 'Program retrofit dengan fase per kuartal.',
      patches: {
        create: [{ version: 'v1.0.0', patchDate: new Date(), notes: 'Initial deployment' }]
      }
    }
  });

  await prisma.news.create({
    data: {
      authorId: admin.id,
      text: 'Maintenance window diumumkan.',
      hasDetail: true,
      body: 'Sistem akan maintenance pukul 01:00 UTC.',
      publishDate: new Date(),
      thumbnail: 'https://placeholder.local/news.jpg',
      attachments: { create: [{ type: MediaType.link, url: 'https://placeholder.local/detail', caption: 'Detail jadwal' }] }
    }
  });

  const lore = await prisma.loreItem.create({
    data: {
      category: EntityType.character,
      name: 'Mikyl',
      type: 'Operator',
      thumbnail: 'https://placeholder.local/mikyl.jpg',
      shortDesc: 'Operator command center',
      fullDesc: '[L3+]Informasi terbatas[/L3+]',
      metadata: { race: 'Human', statCombat: 7 }
    }
  });

  const gallery = await prisma.galleryItem.create({
    data: {
      type: MediaType.image,
      title: 'Outpost Dawn',
      thumbnail: 'https://placeholder.local/outpost.jpg',
      caption: 'Dokumentasi outpost.',
      uploadedBy: mechanic.id,
      tags: { create: [{ tag: 'outpost' }, { tag: 'dawn' }] }
    }
  });

  await prisma.comment.create({
    data: {
      entityType: EntityType.gallery,
      entityId: gallery.id,
      authorId: admin.id,
      text: 'Siapkan patch visual berikutnya.',
      replies: { create: [{ authorId: mechanic.id, text: 'Siap, sedang dijadwalkan.' }] }
    }
  });

  await prisma.entityDoc.create({
    data: {
      entityType: EntityType.character,
      entityId: lore.id,
      type: MediaType.image,
      url: 'https://placeholder.local/docs/mikyl-portrait.jpg',
      caption: 'Portrait'
    }
  });

  await prisma.mapMarker.createMany({
    data: [
      { name: 'Outpost A', status: MapStatus.safe, x: 0.14, y: 0.27, description: 'Zona aman' },
      { name: 'Rift Sector', status: MapStatus.danger, x: 0.68, y: 0.51, description: 'Anomali aktif', loreLink: project.id }
    ]
  });

  await prisma.mapImage.create({ data: { id: 'main', imageUrl: 'https://placeholder.local/map.png' } });

  console.log('Seed complete');
}

main().finally(async () => {
  await prisma.$disconnect();
});
