import { Request } from 'express';
import { prisma } from '../../config/prisma.js';
import { securityFeatures } from '../config.js';
import { createSecurityContext } from '../context.js';
import { recordSecurityEvent } from '../audit/events.js';

export const createSecuritySession = async (
  userId: string,
  req?: Request,
  input: { riskScore?: number } = {}
) => {
  if (!securityFeatures.audit) return undefined;
  const ctx = req?.securityContext ?? (req ? createSecurityContext(req) : undefined);
  const session = await prisma.securitySession.create({
    data: {
      userId,
      ipHash: ctx?.ipHash,
      userAgentHash: ctx?.userAgentHash,
      riskScore: input.riskScore ?? ctx?.riskScore ?? 0
    }
  });
  return session.id;
};

export const touchSecuritySession = async (sessionId?: string, riskScore?: number) => {
  if (!sessionId || !securityFeatures.audit) return;
  await prisma.securitySession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: {
      lastSeenAt: new Date(),
      ...(typeof riskScore === 'number' ? { riskScore } : {})
    }
  });
};

export const revokeSecuritySessions = async (input: { userId?: string; sessionId?: string; reason: string }) => {
  if (!securityFeatures.audit) return { count: 0 };
  return prisma.securitySession.updateMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId ? { id: input.sessionId } : {}),
      revokedAt: null
    },
    data: {
      revokedAt: new Date(),
      revokeReason: input.reason
    }
  });
};

export const ensureSessionAllowed = async (req: Request, sessionId?: string) => {
  if (!sessionId || !securityFeatures.routeRateLimit) return true;
  const session = await prisma.securitySession.findUnique({ where: { id: sessionId } });
  if (!session) {
    await recordSecurityEvent(req, {
      action: 'auth.session.missing',
      severity: 'medium',
      decision: 'allow',
      metadata: { sessionIdPresent: true }
    });
    return true;
  }
  if (session.revokedAt) {
    await recordSecurityEvent(req, {
      action: 'auth.session.revoked',
      severity: 'high',
      decision: 'deny',
      metadata: { sessionId }
    });
    return false;
  }
  await touchSecuritySession(sessionId, req.securityContext?.riskScore);
  return true;
};
