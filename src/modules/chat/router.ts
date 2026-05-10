import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth, allow, hasPl7MaintenanceAccess } from '../../middleware/auth.js';
import { prisma } from '../../config/prisma.js';
import { fail, ok } from '../../utils/response.js';
import { paginated, parsePagination } from '../../utils/pagination.js';
import { createNotification } from '../notifications/service.js';
import { getChatUnreadCount } from '../me/badges.js';
import { reconcileAutoMemberships } from './service.js';
import { emitNavigationBadgesUpdated, emitToUsers } from '../../realtime/events.js';
import { writeAudit } from '../../utils/audit.js';
import { env } from '../../config/env.js';
import { buildObjectProxyUrl, isReadableObjectPath, normalizeObjectPath } from '../files/object-path.js';

export const chatRouter = Router();

const messageSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().optional().default(''),
  attachments: z.array(z.record(z.unknown())).optional().default([]),
  replyTo: z.record(z.unknown()).optional()
});

const messageUpdateSchema = z.object({
  text: z.string().optional().default('')
});

const dmSchema = z.object({
  username: z.string().optional(),
  target: z.string().optional(),
  targetUsername: z.string().optional()
});

const groupSchema = z.object({
  name: z.string().min(1),
  invitees: z.array(z.string()).min(1)
});

const usernamesSchema = z.object({
  usernames: z.array(z.string()).min(1)
});

const memberSchema = z.object({
  username: z.string().min(1)
});

const memberRoleSchema = z.object({
  username: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member'])
});

const nameSchema = z.object({
  name: z.string().min(1)
});

const readSchema = z.object({
  conversationId: z.string().min(1),
  lastReadAt: z.string().optional()
});

const conversationInclude = {
  members: true
} satisfies Prisma.ChatConversationInclude;

const CHAT_MENTION_RE = /@([\w.-]+)/g;

type ConversationWithMembers = Prisma.ChatConversationGetPayload<{ include: typeof conversationInclude }>;

const serializeConversation = (conversation: ConversationWithMembers) => ({
  id: conversation.id,
  kind: conversation.kind,
  name: conversation.name,
  members: conversation.members.map((member) => ({
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

const getActiveMember = (conversation: ConversationWithMembers, username: string) =>
  conversation.members.find((member) => member.username === username && member.status === 'active');

const canManage = (conversation: ConversationWithMembers, username: string) => {
  const role = getActiveMember(conversation, username)?.role;
  return role === 'owner' || role === 'admin';
};

const getConversation = async (id: string) =>
  prisma.chatConversation.findUnique({ where: { id }, include: conversationInclude });

const notifyConversationMembers = async (conversationId: string, sender: string, title: string, link = '/chat') => {
  const members = await prisma.chatConversationMember.findMany({
    where: { conversationId, status: 'active', username: { not: sender } }
  });
  await Promise.all(
    members.map((member) =>
      createNotification({
        kind: 'mention',
        title,
        recipient: member.username,
        sender,
        link
      })
    )
  );
};

const activeUsernames = (conversation: ConversationWithMembers) =>
  conversation.members.filter((member) => member.status === 'active').map((member) => member.username);

const extractMentionedUsernames = (text: string) =>
  Array.from(text.matchAll(CHAT_MENTION_RE))
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((username): username is string => Boolean(username));

const notifyMentionedMembers = async (
  conversation: ConversationWithMembers,
  sender: string,
  text: string
) => {
  const mentioned = extractMentionedUsernames(text);
  if (!mentioned.length) return;

  const activeMembers = conversation.members.filter((member) => member.status === 'active');
  const usernamesByLower = new Map(activeMembers.map((member) => [member.username.toLowerCase(), member.username]));
  const recipients = [...new Set(mentioned)]
    .map((username) => usernamesByLower.get(username))
    .filter((username): username is string => Boolean(username) && username !== sender);

  if (!recipients.length) return;

  const title = conversation.kind === 'dm'
    ? `${sender} mentioned you in chat`
    : `${sender} mentioned you in ${conversation.name}`;

  await Promise.all(
    recipients.map((recipient) =>
      createNotification({
        kind: 'mention',
        title,
        body: text.length > 160 ? `${text.slice(0, 157)}...` : text,
        recipient,
        sender,
        link: '/chat'
      })
    )
  );
};

const normalizeAttachmentUrl = (value: string) => {
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  const base = env.localStorageBasePath.replace(/\/$/, '');
  return `${base}/${value.replace(/^\/+/, '')}`;
};

const normalizeMessageAttachments = (message: any) => {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const normalized = attachments.map((attachment: unknown) => {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const next = { ...(attachment as Record<string, unknown>) };

    if (typeof next.objectPath === 'string') {
      const objectPath = normalizeObjectPath(next.objectPath);
      if (isReadableObjectPath(objectPath)) {
        const proxyUrl = buildObjectProxyUrl(objectPath);
        next.objectPath = objectPath;
        next.proxyUrl = proxyUrl;
        next.url = proxyUrl;
        next.src = proxyUrl;
        next.thumbnailUrl = proxyUrl;
        return next;
      }
    }

    if (typeof next.url === 'string') next.url = normalizeAttachmentUrl(next.url);
    if (typeof next.src === 'string') next.src = normalizeAttachmentUrl(next.src);
    if (typeof next.thumbnailUrl === 'string') next.thumbnailUrl = normalizeAttachmentUrl(next.thumbnailUrl);
    return next;
  });
  return { ...message, attachments: normalized };
};

chatRouter.get('/conversations', auth, async (req, res) => {
  await reconcileAutoMemberships();
  const conversations = await prisma.chatConversation.findMany({
    where: { members: { some: { username: req.user!.username, status: 'active' } } },
    include: conversationInclude,
    orderBy: { updatedAt: 'desc' }
  });
  return ok(res, conversations.map(serializeConversation));
});

chatRouter.post('/reconcile', auth, allow(hasPl7MaintenanceAccess), async (_req, res) => {
  await reconcileAutoMemberships();
  const [instituteGroups, divisionGroups, teamGroups, activeMemberships, removedMemberships] = await Promise.all([
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'institute' } }),
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'division' } }),
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'team' } }),
    prisma.chatConversationMember.count({
      where: { conversation: { systemManaged: true }, status: 'active' }
    }),
    prisma.chatConversationMember.count({
      where: { conversation: { systemManaged: true }, status: 'removed' }
    })
  ]);
  const report = {
    instituteGroups,
    divisionGroups,
    teamGroups,
    activeMemberships,
    removedMemberships,
    ranAt: new Date().toISOString()
  };
  await writeAudit(prisma, {
    actor: _req.user?.username ?? 'system',
    action: 'chat.reconcile',
    entity: 'ChatConversation',
    metadata: report
  });
  return ok(res, report);
});

chatRouter.get('/reconcile/status', auth, allow(hasPl7MaintenanceAccess), async (_req, res) => {
  const latest = await prisma.auditLog.findFirst({
    where: { action: 'chat.reconcile' },
    orderBy: { createdAt: 'desc' }
  });
  if (latest?.metadata && typeof latest.metadata === 'object') {
    const meta = latest.metadata as Record<string, unknown>;
    return ok(res, {
      instituteGroups: Number(meta.instituteGroups ?? 0),
      divisionGroups: Number(meta.divisionGroups ?? 0),
      teamGroups: Number(meta.teamGroups ?? 0),
      activeMemberships: Number(meta.activeMemberships ?? 0),
      removedMemberships: Number(meta.removedMemberships ?? 0),
      ranAt: String(meta.ranAt ?? latest.createdAt.toISOString())
    });
  }

  const [instituteGroups, divisionGroups, teamGroups, activeMemberships, removedMemberships] = await Promise.all([
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'institute' } }),
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'division' } }),
    prisma.chatConversation.count({ where: { systemManaged: true, kind: 'team' } }),
    prisma.chatConversationMember.count({
      where: { conversation: { systemManaged: true }, status: 'active' }
    }),
    prisma.chatConversationMember.count({
      where: { conversation: { systemManaged: true }, status: 'removed' }
    })
  ]);
  return ok(res, {
    instituteGroups,
    divisionGroups,
    teamGroups,
    activeMemberships,
    removedMemberships,
    ranAt: latest?.createdAt.toISOString() ?? new Date(0).toISOString()
  });
});

chatRouter.get('/invites', auth, async (req, res) => {
  const conversations = await prisma.chatConversation.findMany({
    where: { members: { some: { username: req.user!.username, status: 'invited' } } },
    include: conversationInclude,
    orderBy: { updatedAt: 'desc' }
  });
  return ok(res, conversations.map(serializeConversation));
});

chatRouter.get('/conversations/:id/messages', auth, async (req, res) => {
  const conversation = await getConversation(req.params.id);
  if (!conversation) return fail(res, 404, 'Conversation not found', 'NOT_FOUND');
  if (!getActiveMember(conversation, req.user!.username)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const { page, pageSize, skip, take } = parsePagination(req, { pageSize: 50, maxPageSize: 100 });
  const where = { conversationId: conversation.id };
  const [messages, total] = await Promise.all([
    prisma.chatMessage.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take }),
    prisma.chatMessage.count({ where })
  ]);
  return ok(res, paginated(messages.map(normalizeMessageAttachments), page, pageSize, total));
});

chatRouter.post('/messages', auth, async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  if (!parsed.data.text.trim() && parsed.data.attachments.length === 0) {
    return fail(res, 422, 'Text or attachment is required', 'VALIDATION_ERROR');
  }

  const conversation = await getConversation(parsed.data.conversationId);
  if (!conversation) return fail(res, 404, 'Conversation not found', 'NOT_FOUND');
  if (!getActiveMember(conversation, req.user!.username)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  const message = await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      author: req.user!.username,
      text: parsed.data.text,
      attachments: parsed.data.attachments as Prisma.InputJsonArray,
      replyTo: parsed.data.replyTo as Prisma.InputJsonObject | undefined
    }
  });
  await notifyMentionedMembers(conversation, req.user!.username, parsed.data.text);
  const recipients = activeUsernames(conversation);
  emitToUsers(recipients, 'chat.message.created', normalizeMessageAttachments(message) as unknown as Record<string, unknown>);
  emitToUsers(
    recipients.filter((username) => username !== req.user!.username),
    'chat.unread.updated',
    { conversationId: conversation.id }
  );
  await Promise.all(recipients.filter((username) => username !== req.user!.username).map((username) => emitNavigationBadgesUpdated(username)));
  return res.status(201).json({ success: true, data: normalizeMessageAttachments(message) });
});

chatRouter.put('/messages/:id', auth, async (req, res) => {
  const parsed = messageUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const message = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
  if (!message) return fail(res, 404, 'Message not found', 'NOT_FOUND');
  const conversation = await getConversation(message.conversationId);
  if (!conversation) return fail(res, 404, 'Conversation not found', 'NOT_FOUND');
  if (message.author !== req.user!.username && !canManage(conversation, req.user!.username)) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!parsed.data.text.trim() && attachments.length === 0) {
    return fail(res, 422, 'Text or attachment is required', 'VALIDATION_ERROR');
  }

  const updated = await prisma.chatMessage.update({
    where: { id: message.id },
    data: { text: parsed.data.text }
  });
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'chat.message.update',
    entity: 'ChatMessage',
    entityId: updated.id,
    metadata: { conversationId: updated.conversationId }
  });
  const normalized = normalizeMessageAttachments(updated) as unknown as Record<string, unknown>;
  const recipients = activeUsernames(conversation);
  emitToUsers(recipients, 'chat.message.updated', normalized);
  return ok(res, normalized);
});

chatRouter.delete('/messages/:id', auth, async (req, res) => {
  const message = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
  if (!message) return fail(res, 404, 'Message not found', 'NOT_FOUND');
  const conversation = await getConversation(message.conversationId);
  if (!conversation) return fail(res, 404, 'Conversation not found', 'NOT_FOUND');
  if (message.author !== req.user!.username && !canManage(conversation, req.user!.username)) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  await prisma.chatMessage.delete({ where: { id: message.id } });
  const recipients = activeUsernames(conversation);
  emitToUsers(recipients, 'chat.message.deleted', { id: message.id, conversationId: conversation.id });
  await Promise.all(recipients.map((username) => emitNavigationBadgesUpdated(username)));
  return ok(res, { deleted: true });
});

chatRouter.post('/dm', auth, async (req, res) => {
  const parsed = dmSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const target = parsed.data.username ?? parsed.data.target ?? parsed.data.targetUsername;
  if (!target) return fail(res, 422, 'Target username is required', 'VALIDATION_ERROR');
  if (target === req.user!.username) return fail(res, 422, 'Cannot create DM with yourself', 'VALIDATION_ERROR');

  const existing = await prisma.chatConversation.findFirst({
    where: {
      kind: 'dm',
      AND: [
        { members: { some: { username: req.user!.username, status: 'active' } } },
        { members: { some: { username: target, status: 'active' } } }
      ]
    },
    include: conversationInclude
  });
  if (existing) return ok(res, serializeConversation(existing));

  const created = await prisma.chatConversation.create({
    data: {
      kind: 'dm',
      name: `DM ${req.user!.username} & ${target}`,
      createdBy: req.user!.username,
      members: {
        create: [
          { username: req.user!.username, role: 'owner', status: 'active' },
          { username: target, role: 'owner', status: 'active' }
        ]
      }
    },
    include: conversationInclude
  });
  emitToUsers([req.user!.username, target], 'chat.conversation.created', serializeConversation(created));
  return res.status(201).json({ success: true, data: serializeConversation(created) });
});

chatRouter.post('/groups', auth, async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const invitees = [...new Set(parsed.data.invitees.filter((username) => username !== req.user!.username))];
  const created = await prisma.chatConversation.create({
    data: {
      kind: 'group',
      name: parsed.data.name,
      createdBy: req.user!.username,
      members: {
        create: [
          { username: req.user!.username, role: 'owner', status: 'active' },
          ...invitees.map((username) => ({ username, role: 'member', status: 'invited', invitedBy: req.user!.username }))
        ]
      },
      messages: {
        create: { author: 'system', text: `${req.user!.username} created group "${parsed.data.name}"`, system: true }
      }
    },
    include: conversationInclude
  });
  await Promise.all(invitees.map((recipient) => createNotification({ kind: 'request', title: 'Chat invite', recipient, sender: req.user!.username, link: '/chat' })));
  emitToUsers([req.user!.username, ...invitees], 'chat.conversation.created', serializeConversation(created));
  return res.status(201).json({ success: true, data: serializeConversation(created) });
});

chatRouter.post('/conversations/:id/invites', auth, async (req, res) => {
  const parsed = usernamesSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const conversation = await getConversation(req.params.id);
  if (!conversation) return fail(res, 404, 'Conversation not found', 'NOT_FOUND');
  if (conversation.systemManaged || !canManage(conversation, req.user!.username)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');

  for (const username of parsed.data.usernames) {
    if (username === req.user!.username) continue;
    await prisma.chatConversationMember.upsert({
      where: { conversationId_username: { conversationId: conversation.id, username } },
      update: { status: 'invited', invitedBy: req.user!.username },
      create: { conversationId: conversation.id, username, role: 'member', status: 'invited', invitedBy: req.user!.username }
    });
    await createNotification({ kind: 'request', title: 'Chat invite', recipient: username, sender: req.user!.username, link: '/chat' });
  }
  const updated = (await getConversation(conversation.id))!;
  emitToUsers([req.user!.username, ...parsed.data.usernames], 'chat.invite.created', serializeConversation(updated));
  return ok(res, serializeConversation(updated));
});

chatRouter.post('/conversations/:id/invites/accept', auth, async (req, res) => {
  const member = await prisma.chatConversationMember.findUnique({
    where: { conversationId_username: { conversationId: req.params.id, username: req.user!.username } }
  });
  if (!member || member.status !== 'invited') return fail(res, 404, 'Invite not found', 'NOT_FOUND');
  await prisma.chatConversationMember.update({ where: { id: member.id }, data: { status: 'active' } });
  const updated = (await getConversation(req.params.id))!;
  emitToUsers(activeUsernames(updated), 'chat.invite.resolved', { conversationId: updated.id, username: req.user!.username, status: 'accepted' });
  return ok(res, serializeConversation(updated));
});

chatRouter.post('/conversations/:id/invites/reject', auth, async (req, res) => {
  const member = await prisma.chatConversationMember.findUnique({
    where: { conversationId_username: { conversationId: req.params.id, username: req.user!.username } }
  });
  if (!member || member.status !== 'invited') return fail(res, 404, 'Invite not found', 'NOT_FOUND');
  await prisma.chatConversationMember.update({ where: { id: member.id }, data: { status: 'removed' } });
  emitToUsers([req.user!.username], 'chat.invite.resolved', { conversationId: req.params.id, username: req.user!.username, status: 'rejected' });
  return ok(res, { rejected: true });
});

chatRouter.post('/conversations/:id/kick', auth, async (req, res) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const conversation = await getConversation(req.params.id);
  if (!conversation || conversation.systemManaged) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (!canManage(conversation, req.user!.username)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const actor = getActiveMember(conversation, req.user!.username);
  const target = conversation.members.find((member) => member.username === parsed.data.username && member.status === 'active');
  if (!target || target.role === 'owner' || (actor?.role === 'admin' && target.role === 'admin')) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  await prisma.chatConversationMember.update({ where: { id: target.id }, data: { status: 'removed' } });
  const updated = (await getConversation(conversation.id))!;
  emitToUsers([...activeUsernames(updated), target.username], 'chat.conversation.updated', serializeConversation(updated));
  return ok(res, serializeConversation(updated));
});

chatRouter.post('/conversations/:id/leave', auth, async (req, res) => {
  const conversation = await getConversation(req.params.id);
  if (!conversation || conversation.systemManaged) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const member = getActiveMember(conversation, req.user!.username);
  if (!member) return fail(res, 404, 'Membership not found', 'NOT_FOUND');
  await prisma.chatConversationMember.update({ where: { id: member.id }, data: { status: 'removed' } });
  if (member.role === 'owner') {
    const successor = conversation.members.find((item) => item.status === 'active' && item.username !== req.user!.username && item.role === 'admin')
      ?? conversation.members.find((item) => item.status === 'active' && item.username !== req.user!.username);
    if (successor) await prisma.chatConversationMember.update({ where: { id: successor.id }, data: { role: 'owner' } });
  }
  emitToUsers(activeUsernames((await getConversation(conversation.id))!), 'chat.conversation.updated', { conversationId: conversation.id });
  return ok(res, { left: true });
});

chatRouter.put('/conversations/:id/member-role', auth, async (req, res) => {
  const parsed = memberRoleSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const conversation = await getConversation(req.params.id);
  if (!conversation || conversation.systemManaged) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  if (getActiveMember(conversation, req.user!.username)?.role !== 'owner') return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  const target = getActiveMember(conversation, parsed.data.username);
  if (!target) return fail(res, 404, 'Member not found', 'NOT_FOUND');
  if (parsed.data.role === 'owner') {
    const actor = getActiveMember(conversation, req.user!.username);
    if (actor) await prisma.chatConversationMember.update({ where: { id: actor.id }, data: { role: 'admin' } });
  }
  await prisma.chatConversationMember.update({ where: { id: target.id }, data: { role: parsed.data.role } });
  const updated = (await getConversation(conversation.id))!;
  emitToUsers(activeUsernames(updated), 'chat.conversation.updated', serializeConversation(updated));
  return ok(res, serializeConversation(updated));
});

chatRouter.put('/conversations/:id/name', auth, async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const conversation = await getConversation(req.params.id);
  if (!conversation || conversation.systemManaged || !canManage(conversation, req.user!.username)) {
    return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  }
  const updated = await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { name: parsed.data.name },
    include: conversationInclude
  });
  emitToUsers(activeUsernames(updated), 'chat.conversation.updated', serializeConversation(updated));
  return ok(res, serializeConversation(updated));
});

chatRouter.post('/read', auth, async (req, res) => {
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const read = await prisma.chatReadState.upsert({
    where: { conversationId_username: { conversationId: parsed.data.conversationId, username: req.user!.username } },
    update: { lastReadAt: parsed.data.lastReadAt ? new Date(parsed.data.lastReadAt) : new Date() },
    create: {
      conversationId: parsed.data.conversationId,
      username: req.user!.username,
      lastReadAt: parsed.data.lastReadAt ? new Date(parsed.data.lastReadAt) : new Date()
    }
  });
  emitToUsers([req.user!.username], 'chat.read.updated', {
    conversationId: parsed.data.conversationId,
    username: req.user!.username,
    lastReadAt: read.lastReadAt.toISOString()
  });
  emitToUsers([req.user!.username], 'chat.unread.updated', { conversationId: parsed.data.conversationId });
  await emitNavigationBadgesUpdated(req.user!);
  return ok(res, read);
});

chatRouter.get('/unread-count', auth, async (req, res) => ok(res, { count: await getChatUnreadCount(req.user!) }));

chatRouter.get('/unread-counts', auth, async (req, res) => {
  const conversations = await prisma.chatConversation.findMany({
    where: { members: { some: { username: req.user!.username, status: 'active' } } },
    include: { readStates: { where: { username: req.user!.username } } }
  });
  const counts: Record<string, number> = {};
  for (const conversation of conversations) {
    const lastReadAt = conversation.readStates[0]?.lastReadAt ?? new Date(0);
    counts[conversation.id] = await prisma.chatMessage.count({
      where: {
        conversationId: conversation.id,
        author: { not: req.user!.username },
        system: false,
        createdAt: { gt: lastReadAt }
      }
    });
  }
  return ok(res, counts);
});
