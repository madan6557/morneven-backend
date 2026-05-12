import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../config/prisma.js';
import { securityFeatures } from '../config.js';
import { SecurityContext, toSafeMetadata } from '../context.js';

type SecurityEventInput = {
  action: string;
  resource?: string;
  resourceId?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  riskScore?: number;
  decision?: string;
  metadata?: Record<string, unknown>;
};

const requestSecurityContext = (req?: Request): SecurityContext | undefined => req?.securityContext;
const isRequest = (value: Request | SecurityContext | undefined): value is Request =>
  Boolean(value && 'headers' in value);
const isSecurityContext = (value: Request | SecurityContext | undefined): value is SecurityContext =>
  Boolean(value && 'routeGroup' in value);

export const recordSecurityEvent = async (reqOrContext: Request | SecurityContext | undefined, input: SecurityEventInput) => {
  if (!securityFeatures.audit) return;

  const ctx = isSecurityContext(reqOrContext)
    ? reqOrContext
    : isRequest(reqOrContext)
      ? requestSecurityContext(reqOrContext)
      : undefined;
  const req = isRequest(reqOrContext) ? reqOrContext : undefined;
  const metadata = toSafeMetadata({
    ...(input.metadata ?? {}),
    path: ctx?.path,
    method: ctx?.method,
    routeGroup: ctx?.routeGroup,
    signals: ctx?.signals?.map((signal: SecurityContext['signals'][number]) => signal.key)
  }) as Prisma.InputJsonValue;

  try {
    await prisma.securityEvent.create({
      data: {
        requestId: ctx?.requestId,
        actorId: req?.user?.id,
        actorUsername: req?.user?.username,
        sessionId: req?.user?.sessionId ?? ctx?.sessionId,
        ipHash: ctx?.ipHash,
        userAgentHash: ctx?.userAgentHash,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId,
        severity: input.severity ?? 'low',
        riskScore: input.riskScore ?? ctx?.riskScore ?? 0,
        decision: input.decision ?? 'audit',
        metadata
      }
    });
  } catch {
    undefined;
  }
};

export const attachSecurityResponseAudit = (req: Request) => {
  if (!securityFeatures.audit) return;
  const res = req.res;
  if (!res) return;

  res.once('finish', () => {
    const status = res.statusCode;
    if (![401, 403, 429].includes(status)) return;

    void recordSecurityEvent(req, {
      action: status === 429 ? 'request.rate-limited' : status === 403 ? 'request.forbidden' : 'request.unauthorized',
      severity: status === 429 ? 'medium' : 'low',
      decision: 'deny',
      metadata: { status }
    });
  });
};
