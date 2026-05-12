import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { auth, allow } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { fail, ok } from '../../utils/response.js';
import { prisma } from '../../config/prisma.js';
import { getSecurityStatus } from '../../security/config.js';
import { canManageSecurity, canReadSecurity } from '../../security/policies/security-policy.js';
import { createSecurityBlock, revokeSecurityBlock } from '../../security/responders/active-defense.js';
import { hashSecurityValue } from '../../security/context.js';
import { recordSecurityEvent } from '../../security/audit/events.js';
import { revokeSecuritySessions } from '../../security/sessions/session-service.js';

export const securityRouter = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  severity: z.string().trim().min(1).max(30).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  decision: z.string().trim().min(1).max(30).optional()
});

const blockSchema = z.object({
  subjectType: z.enum(['ip', 'user', 'session', 'custom']),
  subjectValue: z.string().trim().min(1).max(500).optional(),
  subjectHash: z.string().trim().min(16).max(256).optional(),
  reason: z.string().trim().min(3).max(500),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  ttlMinutes: z.coerce.number().int().min(1).max(10080).default(60)
}).refine((value) => value.subjectValue || value.subjectHash, {
  path: ['subjectValue'],
  message: 'subjectValue or subjectHash is required'
});

const revokeBlockSchema = z.object({
  reason: z.string().trim().min(3).max(500).default('Manual unblock')
});

const revokeSessionSchema = z.object({
  reason: z.string().trim().min(3).max(500).default('Manual session revoke')
});

securityRouter.use(auth);

securityRouter.get('/status', allow(canReadSecurity), async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [events24h, highEvents24h, activeBlocks, sessionsActive, quarantinedFiles] = await Promise.all([
    prisma.securityEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.securityEvent.count({ where: { createdAt: { gte: since }, severity: { in: ['high', 'critical'] } } }),
    prisma.securityBlock.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.securitySession.count({ where: { revokedAt: null } }),
    prisma.fileScanRecord.count({ where: { verdict: 'quarantined' } })
  ]);

  return ok(res, {
    ...getSecurityStatus(),
    stats: {
      events24h,
      highEvents24h,
      activeBlocks,
      sessionsActive,
      quarantinedFiles
    }
  });
});

securityRouter.get('/events', allow(canReadSecurity), async (req, res) => {
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', query.error.flatten());

  const where: Prisma.SecurityEventWhereInput = {
    ...(query.data.severity ? { severity: query.data.severity } : {}),
    ...(query.data.action ? { action: { contains: query.data.action, mode: 'insensitive' } } : {}),
    ...(query.data.decision ? { decision: query.data.decision } : {})
  };

  const events = await prisma.securityEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: query.data.limit
  });

  return ok(res, events);
});

securityRouter.get('/blocks', allow(canReadSecurity), async (_req, res) => {
  const blocks = await prisma.securityBlock.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  return ok(res, blocks);
});

securityRouter.post('/blocks', allow(canManageSecurity), validateBody(blockSchema), async (req, res) => {
  const body = req.body;
  const block = await createSecurityBlock({
    subjectType: body.subjectType,
    subjectValue: body.subjectValue,
    subjectHash: body.subjectHash,
    reason: body.reason,
    severity: body.severity,
    ttlMs: body.ttlMinutes * 60 * 1000,
    createdBy: req.user!.username
  });

  if (!block) return fail(res, 409, 'Security active defense is disabled', 'SECURITY_DISABLED');
  await recordSecurityEvent(req, {
    action: 'security.block.create',
    severity: body.severity,
    decision: 'allow',
    resource: 'SecurityBlock',
    resourceId: block.id,
    metadata: { subjectType: body.subjectType }
  });
  return res.status(201).json({ success: true, data: block });
});

securityRouter.post('/blocks/:id/revoke', allow(canManageSecurity), validateBody(revokeBlockSchema), async (req, res) => {
  const block = await revokeSecurityBlock(req.params.id, req.body.reason);
  await recordSecurityEvent(req, {
    action: 'security.block.revoke',
    severity: 'medium',
    decision: 'allow',
    resource: 'SecurityBlock',
    resourceId: block.id
  });
  return ok(res, block);
});

securityRouter.get('/sessions', allow(canReadSecurity), async (_req, res) => {
  const sessions = await prisma.securitySession.findMany({
    include: {
      user: {
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          level: true,
          track: true,
          accountStatus: true
        }
      }
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 100
  });
  return ok(res, sessions);
});

securityRouter.post('/sessions/:id/revoke', allow(canManageSecurity), validateBody(revokeSessionSchema), async (req, res) => {
  const result = await revokeSecuritySessions({ sessionId: req.params.id, reason: req.body.reason });
  await prisma.refreshToken.deleteMany({ where: { sessionId: req.params.id } });
  await recordSecurityEvent(req, {
    action: 'security.session.revoke',
    severity: 'high',
    decision: 'allow',
    resource: 'SecuritySession',
    resourceId: req.params.id
  });
  return ok(res, result);
});

securityRouter.get('/file-scans', allow(canReadSecurity), async (_req, res) => {
  const records = await prisma.fileScanRecord.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  return ok(res, records);
});

securityRouter.get('/hash', allow(canManageSecurity), async (req, res) => {
  const value = typeof req.query.value === 'string' ? req.query.value : '';
  if (!value.trim()) return fail(res, 400, 'value query is required', 'VALIDATION_ERROR');
  return ok(res, { hash: hashSecurityValue(value.trim()) });
});
