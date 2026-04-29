import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role, Track } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { fail } from '../utils/response.js';
import { AuthUser } from '../types/auth.js';

export const auth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return fail(res, 401, 'Missing token', 'UNAUTHORIZED');

  try {
    const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');

    req.user = { id: user.id, username: user.username, role: user.role, level: user.level, track: user.track };
    return next();
  } catch {
    return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');
  }
};

export const allow = (rule: (u: AuthUser) => boolean) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  if (!rule(req.user)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return next();
};

export const canWriteNews = (u: AuthUser) => u.level === 7 || (u.level === 6 && u.track === Track.executive);
export const canWriteProjects = (u: AuthUser) =>
  u.level === 7 || (u.level === 6 && [Track.mechanic, Track.executive].includes(u.track));

export const canWriteLore = (u: AuthUser, category: string) => {
  if (u.level === 7 || (u.level === 6 && u.track === Track.executive)) return true;
  if (u.level !== 6) return false;
  if (category === 'places' || category === 'creatures') return u.track === Track.field;
  if (category === 'technology') return u.track === Track.mechanic;
  return false;
};

export const canModerateDiscussion = (u: AuthUser) => u.level === 7 || (u.level === 6 && u.track === Track.executive);
export const canWriteGallery = (u: AuthUser) => u.level >= 6 && u.role !== Role.guest;
