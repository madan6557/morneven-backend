import { NextFunction, Request, Response } from 'express';
import { fail } from '../utils/response.js';
import { createSecurityContext } from './context.js';
import { securityFeatures, securityEnabled } from './config.js';
import { evaluateRequestRisk } from './detectors/request-risk.js';
import { attachSecurityResponseAudit, recordSecurityEvent } from './audit/events.js';
import { createSecurityBlock, findActiveRequestBlock } from './responders/active-defense.js';

export const securityGateway = async (req: Request, res: Response, next: NextFunction) => {
  const ctx = createSecurityContext(req, res);
  req.securityContext = ctx;

  if (!securityEnabled) return next();

  attachSecurityResponseAudit(req);

  const block = await findActiveRequestBlock(ctx);
  if (block) {
    await recordSecurityEvent(ctx, {
      action: 'active-defense.block.hit',
      severity: 'high',
      decision: 'deny',
      metadata: { blockId: block.id, reason: block.reason }
    });
    return fail(res, 403, 'Request blocked by security policy', 'SECURITY_BLOCKED');
  }

  const risk = evaluateRequestRisk(req);
  ctx.riskScore = risk.riskScore;
  ctx.signals = risk.signals;

  if (securityFeatures.audit && ctx.riskScore >= 20) {
    await recordSecurityEvent(ctx, {
      action: 'request.risk.detected',
      severity: ctx.riskScore >= 70 ? 'high' : 'medium',
      decision: 'audit',
      metadata: { signals: ctx.signals }
    });
  }

  if (securityFeatures.blockHighRiskRequests && ctx.riskScore >= 70) {
    if (securityFeatures.activeDefense && ctx.ipHash) {
      await createSecurityBlock({
        subjectType: 'ip',
        subjectHash: ctx.ipHash,
        reason: 'High risk request pattern',
        severity: 'high'
      });
    }
    await recordSecurityEvent(ctx, {
      action: 'request.risk.blocked',
      severity: 'high',
      decision: 'deny',
      metadata: { signals: ctx.signals }
    });
    return fail(res, 403, 'Request blocked by security policy', 'SECURITY_BLOCKED');
  }

  return next();
};
