import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { Role, Track } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { auth } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/security.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { serializeUser } from '../../utils/serializers.js';
import { ensureInstituteMembership, syncDivisionMembership } from '../chat/service.js';
import { createNotification } from '../notifications/service.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  username: z.string().min(3).max(30)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10)
});

const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

const issueTokens = async (user: { id: string; username: string; role: Role; level: number; track: Track }) => {
  const token = jwt.sign({ sub: user.id, username: user.username, role: user.role, level: user.level, track: user.track }, env.jwtAccessSecret, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ sub: user.id }, env.jwtRefreshSecret, { expiresIn: '7d' });
  await prisma.refreshToken.create({
    data: {
      token: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 86400000)
    }
  });
  return { token, refreshToken };
};

authRouter.post('/register', authRateLimiter, validateBody(registerSchema), async (req, res) => {
  const { email, password, username } = req.body;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) return fail(res, 409, 'User already exists', 'CONFLICT');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, username, passwordHash, role: Role.personel, level: 1, track: Track.executive }
  });

  await prisma.commandCenterSettings.create({ data: { userId: user.id } });
  const { token, refreshToken } = await issueTokens(user);
  await ensureInstituteMembership(user.username, user.level);
  await syncDivisionMembership(user.username, user.track, user.level);
  await createNotification({
    kind: 'system',
    title: 'Welcome to Morneven Institute',
    body: 'Your personnel account is active.',
    recipient: user.username,
    sender: 'system',
    link: '/home'
  });

  return ok(res, { token, refreshToken, user: serializeUser(user) }, 'Registered');
});

authRouter.post('/login', authRateLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');

  await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
  const { token, refreshToken } = await issueTokens(user);

  return ok(res, {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      level: user.level,
      track: user.track,
      note: user.note
    }
  });
});

authRouter.post('/refresh', authRateLimiter, validateBody(refreshSchema), async (req, res) => {
  const { refreshToken } = req.body;

  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as { sub: string };
    const hashed = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { token: hashed } });

    if (!stored || stored.userId !== payload.sub || stored.expiresAt <= new Date()) {
      return fail(res, 401, 'Invalid refresh token', 'UNAUTHORIZED');
    }

    await prisma.refreshToken.delete({ where: { token: hashed } });
    const dbUser = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!dbUser) return fail(res, 401, 'Invalid refresh token', 'UNAUTHORIZED');
    const rotated = await issueTokens(dbUser);

    return ok(res, { token: rotated.token, refreshToken: rotated.refreshToken });
  } catch {
    return fail(res, 401, 'Invalid refresh token', 'UNAUTHORIZED');
  }
});

authRouter.get('/me', auth, async (req, res) => ok(res, req.user));


authRouter.post('/guest', async (_req, res) => {
  const token = jwt.sign(
    { sub: 'guest', username: 'guest', role: Role.guest, level: 0, track: Track.executive },
    env.jwtAccessSecret,
    { expiresIn: '15m' }
  );

  return ok(res, {
    token,
    refreshToken: null,
    user: { id: 'guest', username: 'guest', email: null, role: Role.guest, level: 0, track: Track.executive }
  });
});
authRouter.post('/logout', auth, async (req, res) => {
  await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
  return ok(res, { loggedOut: true });
});

authRouter.post('/validate-token', auth, async (_req, res) => ok(res, { valid: true }));
