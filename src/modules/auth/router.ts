import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { AccountStatus, Role, Track } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { allow, auth, hasPl7MaintenanceAccess } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/security.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { normalizeUserRole, serializeUser } from '../../utils/serializers.js';
import { ensureInstituteMembership, syncDivisionMembership } from '../chat/service.js';
import { createNotification } from '../notifications/service.js';
import { updateAccountStatus } from '../personnel/service.js';
import { writeAudit } from '../../utils/audit.js';
import { createSecuritySession, revokeSecuritySessions, touchSecuritySession } from '../../security/sessions/session-service.js';
import { recordSecurityEvent } from '../../security/audit/events.js';
import { securityFeatures } from '../../security/config.js';

export const authRouter = Router();
const passwordResetRequestModel = (prisma as any).passwordResetRequest as {
  findFirst: (args: Record<string, unknown>) => Promise<any>;
  findMany: (args: Record<string, unknown>) => Promise<any[]>;
  findUnique: (args: Record<string, unknown>) => Promise<any>;
  create: (args: Record<string, unknown>) => Promise<any>;
  update: (args: Record<string, unknown>) => Promise<any>;
};

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
  refreshToken: z.string().min(10).optional()
});
const forgotPasswordSchema = z.object({
  email: z.string().email()
});
const passwordResetRequestSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30),
  newPassword: z.string().min(12).max(128),
  confirmPassword: z.string().min(12).max(128),
  identityProof: z.string().min(12).max(2000)
}).refine((value) => value.newPassword === value.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Password confirmation does not match'
});
const passwordResetConfirmSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30),
  newPassword: z.string().min(12).max(128),
  confirmPassword: z.string().min(12).max(128)
}).refine((value) => value.newPassword === value.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Password confirmation does not match'
});
const passwordResetReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewNote: z.string().trim().max(1000).optional()
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128)
});
const deleteAccountSchema = z.object({
  password: z.string().min(1)
});

const serializePasswordResetRequest = (
  request: {
    id: string;
    email: string;
    username: string;
    identityProof: string;
    status: string;
    reviewNote?: string | null;
    createdAt: Date;
    updatedAt: Date;
    reviewedAt?: Date | null;
    completedAt?: Date | null;
    targetUser?: { id: string; username: string; email: string; level: number; role: Role; track: Track } | null;
    reviewedBy?: { id: string; username: string; email: string; level: number; role: Role; track: Track } | null;
  }
) => ({
  id: request.id,
  email: request.email,
  username: request.username,
  identityProof: request.identityProof,
  status: request.status,
  reviewNote: request.reviewNote ?? undefined,
  createdAt: request.createdAt.toISOString(),
  updatedAt: request.updatedAt.toISOString(),
  reviewedAt: request.reviewedAt?.toISOString(),
  completedAt: request.completedAt?.toISOString(),
  targetUser: request.targetUser ? serializeUser(request.targetUser as any) : undefined,
  reviewedBy: request.reviewedBy ? serializeUser(request.reviewedBy as any) : undefined
});

const inactiveAccountFailure = (status: AccountStatus) => {
  if (status === AccountStatus.banned) return ['Account is banned', 'ACCOUNT_BANNED'] as const;
  if (status === AccountStatus.suspended) return ['Account is suspended', 'ACCOUNT_SUSPENDED'] as const;
  if (status === AccountStatus.deleted) return ['Account has been deleted', 'ACCOUNT_DELETED'] as const;
  return ['Account is not active', 'ACCOUNT_INACTIVE'] as const;
};

const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

const readCookie = (req: Request, name: string) => {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const pair = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined;
};

const setAuthCookies = (res: Response, tokens: { token: string; refreshToken: string }) => {
  if (!env.authCookieEnabled) return;
  const cookieOptions = {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'none' as const,
    path: '/',
    ...(env.authCookieDomain ? { domain: env.authCookieDomain } : {})
  };
  res.cookie('morneven_access_token', tokens.token, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
  res.cookie('morneven_refresh_token', tokens.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
};

const clearAuthCookies = (res: Response) => {
  if (!env.authCookieEnabled) return;
  const cookieOptions = {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'none' as const,
    path: '/',
    ...(env.authCookieDomain ? { domain: env.authCookieDomain } : {})
  };
  res.clearCookie('morneven_access_token', cookieOptions);
  res.clearCookie('morneven_refresh_token', cookieOptions);
};

const issueTokens = async (
  user: { id: string; username: string; role: Role; level: number; track: Track },
  req?: Request,
  existingSessionId?: string
) => {
  const sessionId = existingSessionId ?? (await createSecuritySession(user.id, req));
  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role, level: user.level, track: user.track, sid: sessionId },
    env.jwtAccessSecret,
    { expiresIn: '1h' }
  );
  const refreshToken = jwt.sign({ sub: user.id, sid: sessionId }, env.jwtRefreshSecret, { expiresIn: '7d' });
  const stored = await prisma.refreshToken.create({
    data: {
      token: hashRefreshToken(refreshToken),
      userId: user.id,
      sessionId,
      expiresAt: new Date(Date.now() + 7 * 86400000)
    }
  });
  if (sessionId) await touchSecuritySession(sessionId);
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

  const { token, refreshToken } = await issueTokens(user, req);
  setAuthCookies(res, { token, refreshToken });
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
  if (!user) {
    await recordSecurityEvent(req, { action: 'auth.login.failed', severity: 'low', decision: 'deny', metadata: { reason: 'unknown-email' } });
    return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');
  }
  if (user.accountStatus !== AccountStatus.active) {
    const [message, errorCode] = inactiveAccountFailure(user.accountStatus);
    await recordSecurityEvent(req, { action: 'auth.login.inactive', severity: 'medium', decision: 'deny', metadata: { accountStatus: user.accountStatus } });
    return fail(res, 403, message, errorCode);
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await recordSecurityEvent(req, { action: 'auth.login.failed', severity: 'low', decision: 'deny', metadata: { reason: 'bad-password', userId: user.id } });
    return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');
  }

  await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
  const { token, refreshToken } = await issueTokens(user, req);
  setAuthCookies(res, { token, refreshToken });
  await recordSecurityEvent(req, { action: 'auth.login.success', severity: 'low', decision: 'allow', metadata: { userId: user.id } });

  return ok(res, {
    token,
    refreshToken,
    user: {
      ...serializeUser(user),
      role: normalizeUserRole(user.role, user.level)
    }
  });
});

authRouter.post('/refresh', authRateLimiter, validateBody(refreshSchema), async (req, res) => {
  const refreshToken = req.body.refreshToken || readCookie(req, 'morneven_refresh_token');

  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as { sub: string; sid?: string };
    const hashed = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { token: hashed } });

    if (!stored || stored.userId !== payload.sub || stored.expiresAt <= new Date()) {
      if (securityFeatures.activeDefense) {
        await prisma.refreshToken.deleteMany({ where: { userId: payload.sub } });
        await revokeSecuritySessions({ userId: payload.sub, reason: 'Refresh token reuse or invalid refresh token' });
      }
      await recordSecurityEvent(req, {
        action: 'auth.refresh.reuse-or-invalid',
        severity: 'high',
        decision: 'deny',
        metadata: { userId: payload.sub, sessionId: payload.sid }
      });
      return fail(res, 401, 'Invalid refresh token', 'UNAUTHORIZED');
    }

    await prisma.refreshToken.delete({ where: { token: hashed } });
    const dbUser = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!dbUser) return fail(res, 401, 'Invalid refresh token', 'UNAUTHORIZED');
    if (dbUser.accountStatus !== AccountStatus.active) {
      await prisma.refreshToken.deleteMany({ where: { userId: dbUser.id } });
      const [message, errorCode] = inactiveAccountFailure(dbUser.accountStatus);
      return fail(res, 403, message, errorCode);
    }
    const rotated = await issueTokens(dbUser, req, stored.sessionId ?? payload.sid);
    setAuthCookies(res, { token: rotated.token, refreshToken: rotated.refreshToken });

    return ok(res, { token: rotated.token, refreshToken: rotated.refreshToken });
  } catch {
    await recordSecurityEvent(req, { action: 'auth.refresh.invalid', severity: 'medium', decision: 'deny' });
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
    user: { id: 'guest', username: 'guest', email: null, role: Role.guest, status: AccountStatus.active, level: 0, track: Track.executive }
  });
});
authRouter.post('/logout', auth, async (req, res) => {
  await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
  await revokeSecuritySessions({ userId: req.user!.id, reason: 'User logout' });
  clearAuthCookies(res);
  return ok(res, { loggedOut: true });
});

authRouter.post('/validate-token', auth, async (_req, res) => ok(res, { valid: true }));

authRouter.post('/forgot-password', authRateLimiter, validateBody(forgotPasswordSchema), async (req, res) => {
  const email = String(req.body.email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    console.log(`Password reset requested for ${email}`);
  }
  return ok(res, { accepted: true });
});

authRouter.post('/password-reset/request', authRateLimiter, validateBody(passwordResetRequestSchema), async (req, res) => {
  const email = String(req.body.email).trim().toLowerCase();
  const username = String(req.body.username).trim();
  const user = await prisma.user.findFirst({
    where: {
      email,
      username: { equals: username, mode: 'insensitive' }
    }
  });

  if (!user) return fail(res, 404, 'Account not found for the submitted email and username', 'NOT_FOUND');
  if (user.accountStatus === AccountStatus.deleted) return fail(res, 409, 'Deleted accounts cannot request password reset', 'CONFLICT');

  const openRequest = await passwordResetRequestModel.findFirst({
    where: {
      targetUserId: user.id,
      status: { in: ['pending', 'approved'] }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (openRequest) {
    return fail(res, 409, 'There is already an open password reset request for this account', 'CONFLICT');
  }

  const newPasswordHash = await bcrypt.hash(String(req.body.newPassword), 12);
  const created = await passwordResetRequestModel.create({
    data: {
      targetUserId: user.id,
      email,
      username: user.username,
      identityProof: String(req.body.identityProof).trim(),
      newPasswordHash
    },
    include: {
      targetUser: true,
      reviewedBy: true
    }
  });

  const reviewers = await prisma.user.findMany({
    where: {
      level: { gte: 7 },
      accountStatus: AccountStatus.active,
      role: { in: [Role.author, 'admin' as Role, 'security' as Role] }
    }
  });
  await Promise.all(
    reviewers.map((reviewer) =>
      createNotification({
        kind: 'warning',
        title: 'Password reset request submitted',
        body: `${user.username} submitted a password reset request for manual review.`,
        recipient: reviewer.username,
        sender: 'system',
        link: '/settings'
      })
    )
  );

  await writeAudit(prisma, {
    actor: user.username,
    action: 'auth.password-reset.request',
    entity: 'PasswordResetRequest',
    entityId: created.id
  });

  return res.status(201).json({ success: true, data: serializePasswordResetRequest(created) });
});

authRouter.get('/password-reset/requests', auth, allow(hasPl7MaintenanceAccess), async (_req, res) => {
  const requests = await passwordResetRequestModel.findMany({
    include: {
      targetUser: true,
      reviewedBy: true
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
  });
  return ok(res, requests.map(serializePasswordResetRequest));
});

authRouter.post('/password-reset/requests/:id/review', auth, allow(hasPl7MaintenanceAccess), validateBody(passwordResetReviewSchema), async (req, res) => {
  const requestRecord = await passwordResetRequestModel.findUnique({
    where: { id: req.params.id },
    include: {
      targetUser: true,
      reviewedBy: true
    }
  });
  if (!requestRecord) return fail(res, 404, 'Password reset request not found', 'NOT_FOUND');
  if (requestRecord.status !== 'pending') return fail(res, 409, 'Password reset request is already reviewed', 'CONFLICT');

  const reviewed = await passwordResetRequestModel.update({
    where: { id: requestRecord.id },
    data: {
      status: req.body.status,
      reviewNote: req.body.reviewNote?.trim() || null,
      reviewedById: req.user!.id,
      reviewedAt: new Date()
    },
    include: {
      targetUser: true,
      reviewedBy: true
    }
  });

  await createNotification({
    kind: req.body.status === 'approved' ? 'system' : 'warning',
    title: req.body.status === 'approved' ? 'Password reset request approved' : 'Password reset request rejected',
    body:
      req.body.status === 'approved'
        ? 'Your password reset request has been approved. Open credential confirmation to activate the new password.'
        : req.body.reviewNote?.trim() || 'Your password reset request was rejected.',
    recipient: requestRecord.targetUser.username,
    sender: req.user!.username,
    link: '/auth/password-reset/confirm'
  });

  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'auth.password-reset.review',
    entity: 'PasswordResetRequest',
    entityId: reviewed.id,
    metadata: { status: reviewed.status }
  });

  return ok(res, serializePasswordResetRequest(reviewed));
});

authRouter.post('/password-reset/confirm', authRateLimiter, validateBody(passwordResetConfirmSchema), async (req, res) => {
  const email = String(req.body.email).trim().toLowerCase();
  const username = String(req.body.username).trim();
  const requestRecord = await passwordResetRequestModel.findFirst({
    where: {
      email,
      username: { equals: username, mode: 'insensitive' },
      status: 'approved'
    },
    include: {
      targetUser: true
    },
    orderBy: { reviewedAt: 'desc' }
  });

  if (!requestRecord) return fail(res, 404, 'No approved password reset request found', 'NOT_FOUND');
  const valid = await bcrypt.compare(String(req.body.newPassword), requestRecord.newPasswordHash);
  if (!valid) return fail(res, 403, 'Submitted credentials do not match the approved request', 'FORBIDDEN');

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: requestRecord.targetUserId },
      data: { passwordHash: requestRecord.newPasswordHash }
    });
    await (tx as any).passwordResetRequest.update({
      where: { id: requestRecord.id },
      data: {
        status: 'completed',
        completedAt: new Date()
      }
    });
    await tx.refreshToken.deleteMany({ where: { userId: requestRecord.targetUserId } });
    await (tx as any).securitySession.updateMany({
      where: { userId: requestRecord.targetUserId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'Password reset confirmed' }
    });
    await writeAudit(tx, {
      actor: requestRecord.username,
      action: 'auth.password-reset.confirm',
      entity: 'PasswordResetRequest',
      entityId: requestRecord.id
    });
  });

  return ok(res, { confirmed: true });
});

authRouter.post('/change-password', auth, validateBody(changePasswordSchema), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
  if (!valid) return fail(res, 403, 'Current password is invalid', 'FORBIDDEN');
  const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  await revokeSecuritySessions({ userId: user.id, reason: 'Password changed' });
  return ok(res, { changed: true });
});

authRouter.delete('/delete-account', auth, validateBody(deleteAccountSchema), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 401, 'Invalid user', 'UNAUTHORIZED');
  const valid = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!valid) return fail(res, 403, 'Password confirmation failed', 'FORBIDDEN');
  const archived = await prisma.$transaction(async (tx) => {
    const updated = await updateAccountStatus(tx as any, {
      ...user,
      disciplineStrikeCount: user.disciplineStrikeCount,
      disciplineTier: user.disciplineTier
    }, AccountStatus.deleted, 'Self-deleted account');
    await writeAudit(tx, {
      actor: user.username,
      action: 'auth.delete-account',
      entity: 'User',
      entityId: user.id
    });
    await (tx as any).securitySession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'Account deleted' }
    });
    return updated;
  });
  return ok(res, { deleted: true, user: serializeUser(archived) });
});
