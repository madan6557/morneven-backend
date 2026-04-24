import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Role, Track } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { auth } from '../../middleware/auth.js';
import { fail, ok } from '../../utils/response.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(8), username: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const { email, password, username } = parsed.data;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) return fail(res, 409, 'User already exists', 'CONFLICT');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, username, passwordHash, role: Role.personel, level: 2, track: Track.executive }
  });

  await prisma.commandCenterSettings.create({ data: { userId: user.id } });
  return ok(
    res,
    { id: user.id, email: user.email, username: user.username, role: user.role, level: user.level, track: user.track },
    'Registered'
  );
});

authRouter.post('/login', async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');

  const token = jwt.sign({ sub: user.id }, env.jwtAccessSecret, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ sub: user.id }, env.jwtRefreshSecret, { expiresIn: '7d' });

  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt: new Date(Date.now() + 7 * 86400000) }
  });

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

authRouter.get('/me', auth, async (req, res) => ok(res, req.user));

authRouter.post('/logout', auth, async (req, res) => {
  await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
  return ok(res, { loggedOut: true });
});

authRouter.post('/validate-token', auth, async (_req, res) => ok(res, { valid: true }));
