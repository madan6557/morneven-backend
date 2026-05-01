import { Track } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

const tracks = [Track.executive, Track.field, Track.mechanic, Track.logistics];

type ChatDb = any;

const upsertMember = async (
  db: ChatDb,
  conversationId: string,
  username: string,
  role = 'member',
  status = 'active',
  invitedBy?: string
) =>
  db.chatConversationMember.upsert({
    where: { conversationId_username: { conversationId, username } },
    update: { role, status, invitedBy },
    create: { conversationId, username, role, status, invitedBy }
  });

export const ensureInstituteConversation = async (db: ChatDb = prisma) =>
  db.chatConversation.upsert({
    where: { id: 'conv-institute' },
    update: {},
    create: {
      id: 'conv-institute',
      kind: 'institute',
      name: 'Institute - All Personnel',
      source: { institute: true },
      systemManaged: true,
      createdBy: 'system'
    }
  });

export const ensureInstituteMembership = async (username: string, db: ChatDb = prisma) => {
  const conversation = await ensureInstituteConversation(db);
  await upsertMember(db, conversation.id, username, 'member', 'active');
  return conversation;
};

export const syncDivisionMembership = async (username: string, track: Track, level = 1, db: ChatDb = prisma) => {
  for (const divisionTrack of tracks) {
    const conversationId = `conv-div-${divisionTrack}`;
    await db.chatConversation.upsert({
      where: { id: conversationId },
      update: {},
      create: {
        id: conversationId,
        kind: 'division',
        name: `Division - ${divisionTrack.toUpperCase()}`,
        source: { track: divisionTrack },
        systemManaged: true,
        createdBy: 'system'
      }
    });

    const shouldJoin = level >= 7 || divisionTrack === track;
    await upsertMember(db, conversationId, username, level >= 7 ? 'admin' : 'member', shouldJoin ? 'active' : 'removed');
  }
};

export const syncTeamGroup = async (teamId: string, teamName: string, members: string[], db: ChatDb = prisma) => {
  const conversationId = `conv-team-${teamId}`;
  const conversation = await db.chatConversation.upsert({
    where: { id: conversationId },
    update: { name: `Team - ${teamName}` },
    create: {
      id: conversationId,
      kind: 'team',
      name: `Team - ${teamName}`,
      source: { teamId },
      systemManaged: true,
      createdBy: 'system'
    }
  });

  const uniqueMembers = [...new Set(members)];
  for (const username of uniqueMembers) {
    await upsertMember(db, conversation.id, username, 'member', 'active');
  }

  await db.chatConversationMember.updateMany({
    where: { conversationId, username: { notIn: uniqueMembers } },
    data: { status: 'removed' }
  });

  return conversation;
};

export const reconcileAutoMemberships = async (db: ChatDb = prisma) => {
  const users = await db.user.findMany({ where: { level: { gte: 1 } } });
  await ensureInstituteConversation(db);

  for (const user of users) {
    await ensureInstituteMembership(user.username, db);
    await syncDivisionMembership(user.username, user.track, user.level, db);
  }
};
