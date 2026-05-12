import { AccountStatus, Track } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { emitToUsers } from '../../realtime/events.js';

const tracks = [Track.executive, Track.field, Track.mechanic, Track.logistics];

type ChatDb = any;
type SyncOptions = { emit?: boolean };

const serializeSystemConversation = (conversation: any) => ({
  id: conversation.id,
  kind: conversation.kind,
  name: conversation.name,
  members: (conversation.members ?? []).map((member: any) => ({
    username: member.username,
    role: member.role,
    status: member.status,
    invitedBy: member.invitedBy ?? undefined,
    joinedAt: member.joinedAt.toISOString()
  })),
  source: conversation.source ?? undefined,
  systemManaged: conversation.systemManaged,
  createdBy: conversation.createdBy,
  createdAt: conversation.createdAt.toISOString()
});

const emitSystemConversationChange = async (
  db: ChatDb,
  conversationId: string,
  event: 'chat.conversation.created' | 'chat.conversation.updated',
  extraRecipients: string[] = []
) => {
  const conversation = await db.chatConversation.findUnique({
    where: { id: conversationId },
    include: { members: true }
  });
  if (!conversation) return;
  const recipients = [
    ...new Set([
      ...conversation.members.filter((member: any) => member.status === 'active').map((member: any) => member.username),
      ...extraRecipients
    ])
  ];
  if (recipients.length) emitToUsers(recipients, event, serializeSystemConversation(conversation));
};

const upsertSystemConversation = async (
  db: ChatDb,
  id: string,
  data: { kind: string; name: string; source: Record<string, unknown> }
) => {
  const existing = await db.chatConversation.findUnique({ where: { id } });
  if (!existing) {
    return {
      conversation: await db.chatConversation.create({
        data: {
          id,
          kind: data.kind,
          name: data.name,
          source: data.source,
          systemManaged: true,
          createdBy: 'system'
        }
      }),
      created: true,
      changed: true
    };
  }

  const shouldUpdate = existing.name !== data.name || existing.kind !== data.kind || !existing.systemManaged;
  const conversation = shouldUpdate
    ? await db.chatConversation.update({
        where: { id },
        data: { kind: data.kind, name: data.name, source: data.source, systemManaged: true, createdBy: existing.createdBy ?? 'system' }
      })
    : existing;
  return { conversation, created: false, changed: shouldUpdate };
};

const upsertMember = async (
  db: ChatDb,
  conversationId: string,
  username: string,
  role = 'member',
  status = 'active',
  invitedBy?: string | null
) => {
  const existing = await db.chatConversationMember.findUnique({
    where: { conversationId_username: { conversationId, username } }
  });
  if (!existing) {
    await db.chatConversationMember.create({ data: { conversationId, username, role, status, invitedBy } });
    return true;
  }

  const changed = existing.role !== role || existing.status !== status || existing.invitedBy !== (invitedBy ?? null);
  if (changed) {
    await db.chatConversationMember.update({
      where: { id: existing.id },
      data: { role, status, invitedBy }
    });
  }
  return changed;
};

export const ensureInstituteConversation = async (db: ChatDb = prisma, options: SyncOptions = {}) => {
  const result = await upsertSystemConversation(db, 'conv-institute', {
    kind: 'institute',
    name: 'Institute - All Personnel',
    source: { institute: true }
  });
  if (options.emit !== false && result.created) {
    await emitSystemConversationChange(db, result.conversation.id, 'chat.conversation.created');
  }
  return result.conversation;
};

export const ensureInstituteMembership = async (
  username: string,
  level = 1,
  db: ChatDb = prisma,
  options: SyncOptions = {}
) => {
  const conversation = await ensureInstituteConversation(db, { emit: options.emit });
  const status = level >= 1 ? 'active' : 'removed';
  const changed = await upsertMember(db, conversation.id, username, 'member', status);
  if (options.emit !== false && changed) {
    await emitSystemConversationChange(db, conversation.id, 'chat.conversation.updated', [username]);
  }
  return conversation;
};

export const syncDivisionMembership = async (
  username: string,
  track: Track,
  level = 1,
  db: ChatDb = prisma,
  options: SyncOptions = {}
) => {
  for (const divisionTrack of tracks) {
    const conversationId = `conv-div-${divisionTrack}`;
    const result = await upsertSystemConversation(db, conversationId, {
        kind: 'division',
        name: `Division - ${divisionTrack.toUpperCase()}`,
        source: { track: divisionTrack }
    });

    const shouldJoin = level >= 7 || (level >= 1 && divisionTrack === track);
    const changed = await upsertMember(db, conversationId, username, level >= 7 ? 'admin' : 'member', shouldJoin ? 'active' : 'removed');
    if (options.emit !== false && (result.created || result.changed || changed)) {
      await emitSystemConversationChange(
        db,
        conversationId,
        result.created ? 'chat.conversation.created' : 'chat.conversation.updated',
        [username]
      );
    }
  }
};

export const syncTeamGroup = async (
  teamId: string,
  teamName: string,
  members: string[],
  db: ChatDb = prisma,
  options: SyncOptions = {}
) => {
  const conversationId = `conv-team-${teamId}`;
  const result = await upsertSystemConversation(db, conversationId, {
      kind: 'team',
      name: `Team - ${teamName}`,
      source: { teamId }
  });

  const uniqueMembers = [...new Set(members.filter(Boolean))];
  let changed = result.created || result.changed;
  for (const username of uniqueMembers) {
    changed = (await upsertMember(db, result.conversation.id, username, 'member', 'active')) || changed;
  }

  const removedMembers = await db.chatConversationMember.findMany({
    where: { conversationId, username: { notIn: uniqueMembers }, status: { not: 'removed' } },
    select: { username: true }
  });
  if (removedMembers.length) {
    await db.chatConversationMember.updateMany({
      where: { conversationId, username: { notIn: uniqueMembers } },
      data: { status: 'removed' }
    });
    changed = true;
  }

  if (options.emit !== false && changed) {
    await emitSystemConversationChange(
      db,
      conversationId,
      result.created ? 'chat.conversation.created' : 'chat.conversation.updated',
      removedMembers.map((member: { username: string }) => member.username)
    );
  }

  return result.conversation;
};

export const revokeConversationAccessForUser = async (
  username: string,
  db: ChatDb = prisma,
  options: SyncOptions = {}
) => {
  const memberships = await db.chatConversationMember.findMany({
    where: {
      username,
      status: { in: ['active', 'invited'] },
      conversation: { systemManaged: false }
    },
    select: { conversationId: true }
  });
  if (!memberships.length) return;

  await db.chatConversationMember.updateMany({
    where: {
      username,
      status: { in: ['active', 'invited'] },
      conversation: { systemManaged: false }
    },
    data: { status: 'removed' }
  });

  if (options.emit === false) return;

  for (const conversationId of [...new Set(memberships.map((membership: { conversationId: string }) => membership.conversationId))]) {
    const conversation = await db.chatConversation.findUnique({
      where: { id: conversationId },
      include: { members: true }
    });
    if (!conversation) continue;
    const recipients = [
      ...new Set([
        ...conversation.members.filter((member: any) => member.status === 'active').map((member: any) => member.username),
        username
      ])
    ];
    if (recipients.length) {
      emitToUsers(recipients, 'chat.conversation.updated', { conversationId, invalidated: true });
    }
  }
};

export const reconcileAutoMemberships = async (db: ChatDb = prisma, options: SyncOptions = {}) => {
  const users = await db.user.findMany({ select: { username: true, track: true, level: true, accountStatus: true } });
  const activeUsernames = users
    .filter((user: { level: number; accountStatus: AccountStatus }) => user.level >= 1 && user.accountStatus === AccountStatus.active)
    .map((user: { username: string }) => user.username);
  const activeUserSet = new Set(activeUsernames);

  await ensureInstituteConversation(db, { emit: options.emit });

  for (const user of users) {
    const effectiveLevel = user.accountStatus === AccountStatus.active ? user.level : 0;
    await ensureInstituteMembership(user.username, effectiveLevel, db, { emit: options.emit });
    await syncDivisionMembership(user.username, user.track, effectiveLevel, db, { emit: options.emit });
  }

  const removedInstituteMembers = await db.chatConversationMember.findMany({
    where: { conversationId: 'conv-institute', username: { notIn: activeUsernames }, status: { not: 'removed' } },
    select: { username: true }
  });
  if (removedInstituteMembers.length) {
    await db.chatConversationMember.updateMany({
      where: { conversationId: 'conv-institute', username: { notIn: activeUsernames } },
      data: { status: 'removed' }
    });
    if (options.emit !== false) {
      await emitSystemConversationChange(
        db,
        'conv-institute',
        'chat.conversation.updated',
        removedInstituteMembers.map((member: { username: string }) => member.username)
      );
    }
  }

  const teams = await db.team.findMany({ select: { id: true, name: true, leader: true, members: true } });
  for (const team of teams) {
    const members = Array.isArray(team.members) ? (team.members as string[]) : [];
    const activeMembers = [team.leader, ...members].filter((username) => activeUserSet.has(username));
    await syncTeamGroup(team.id, team.name, activeMembers, db, { emit: options.emit });
  }
};
