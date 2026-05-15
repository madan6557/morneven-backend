import { IncomingMessage, Server } from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import jwt from 'jsonwebtoken';
import { AccountStatus, Role, Track } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AuthUser } from '../types/auth.js';
import { emitToMatchingClients, emitToUsers, registerRealtimeClient } from './events.js';
import { markPresenceOffline, markPresenceOnline } from '../modules/presence/service.js';
import { normalizeUserRole } from '../utils/serializers.js';
import { securityFeatures } from '../security/config.js';
import { restoreExpiredAccountStatus } from '../modules/personnel/service.js';

const acceptKey = (key: string) =>
  createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

const writeFrame = (socket: Socket, value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
};

const decodeTextFrame = (buffer: Buffer) => {
  if (buffer.length < 6) return null;
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) return '__close__';
  if (opcode !== 0x1) return null;

  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    return null;
  }

  const masked = (buffer[1] & 0x80) === 0x80;
  if (!masked) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = buffer.subarray(offset, offset + length);
  const decoded = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) decoded[i] = payload[i] ^ mask[i % 4];
  return decoded.toString('utf8');
};

const getToken = (req: IncomingMessage) => {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
};

const authenticate = async (req: IncomingMessage): Promise<AuthUser | null> => {
  const token = getToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, env.jwtAccessSecret) as {
      sub: string;
      username?: string;
      role?: Role;
      level?: number;
      track?: Track;
      sid?: string;
    };

    if (payload.sub === 'guest' && payload.role === Role.guest) {
      return { id: 'guest', username: 'guest', role: Role.guest, accountStatus: AccountStatus.active, level: 0, track: Track.executive, sessionId: payload.sid };
    }

    let user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;
    user = await restoreExpiredAccountStatus(prisma, user);
    if (user.accountStatus !== AccountStatus.active) return null;
    if (securityFeatures.routeRateLimit && payload.sid) {
      const session = await prisma.securitySession.findUnique({ where: { id: payload.sid } });
      if (session?.revokedAt) return null;
      if (session) {
        await prisma.securitySession.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date() }
        });
      }
    }
    return {
      id: user.id,
      username: user.username,
      role: normalizeUserRole(user.role, user.level),
      accountStatus: user.accountStatus,
      level: user.level,
      track: user.track,
      sessionId: payload.sid
    };
  } catch {
    return null;
  }
};

const conversationRecipients = async (conversationId: string, exclude?: string) => {
  const members = await prisma.chatConversationMember.findMany({
    where: { conversationId, status: { in: ['active', 'invited'] }, ...(exclude ? { username: { not: exclude } } : {}) }
  });
  return members.map((member) => member.username);
};

const handleClientEvent = async (user: AuthUser, raw: string) => {
  const parsed = JSON.parse(raw) as { event?: string; payload?: Record<string, unknown> };
  const conversationId = typeof parsed.payload?.conversationId === 'string' ? parsed.payload.conversationId : undefined;
  if (!conversationId) return;

  const member = await prisma.chatConversationMember.findUnique({
    where: { conversationId_username: { conversationId, username: user.username } }
  });
  if (!member || !['active', 'invited'].includes(member.status)) return;

  if (parsed.event === 'chat.typing.started' || parsed.event === 'chat.typing.stopped' || parsed.event === 'chat.read.updated') {
    emitToUsers(await conversationRecipients(conversationId, user.username), parsed.event, {
      conversationId,
      username: user.username,
      at: new Date().toISOString()
    });
  }
};

export const attachRealtimeWebSocket = (server: Server) => {
  server.on('upgrade', async (req, rawSocket) => {
    const socket = rawSocket as Socket;
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    if (pathname !== '/ws/chat' && pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const user = await authenticate(req);
    if (!user || user.role === Role.guest) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n'
      ].join('\r\n')
    );

    const unregister = registerRealtimeClient({
      user,
      send: (event, payload) => writeFrame(socket, { event, payload }),
      close: () => socket.end()
    });

    const onlineSnapshot = markPresenceOnline(user.username);
    if (onlineSnapshot.changed) {
      emitToMatchingClients(
        (viewer) => viewer.level >= 4,
        'presence.updated',
        { username: user.username, ...onlineSnapshot }
      );
    }

    writeFrame(socket, { event: 'socket.ready', payload: { username: user.username } });

    socket.on('data', (buffer) => {
      if (!Buffer.isBuffer(buffer)) return;
      const text = decodeTextFrame(buffer);
      if (text === '__close__') {
        socket.end();
        return;
      }
      if (!text) return;
      void handleClientEvent(user, text).catch(() => undefined);
    });
    const teardown = () => {
      unregister();
      const offlineSnapshot = markPresenceOffline(user.username);
      if (offlineSnapshot.changed) {
        emitToMatchingClients(
          (viewer) => viewer.level >= 4,
          'presence.updated',
          { username: user.username, ...offlineSnapshot }
        );
      }
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });
};
