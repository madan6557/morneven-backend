import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { fail, ok } from '../../utils/response.js';
import { bootstrapSnapshot, listChanges, pushChanges, type SyncMutation } from './service.js';

export const syncRouter = Router();

const mutationSchema = z.object({
  opId: z.string().min(1).max(120),
  entity: z.enum(['project', 'lore', 'gallery']),
  id: z.string().min(1).max(120),
  action: z.enum(['upsert', 'delete']),
  baseSequence: z.string().regex(/^\d+$/).nullable(),
  record: z.unknown().optional()
});

syncRouter.get('/bootstrap', auth, async (_req, res) => ok(res, await bootstrapSnapshot()));

syncRouter.get('/changes', auth, async (req, res) => {
  const after = String(req.query.after ?? '0');
  const limit = Number(req.query.limit ?? 100);
  if (!/^\d+$/.test(after) || !Number.isFinite(limit)) return fail(res, 400, 'Invalid sync cursor', 'BAD_REQUEST');
  return ok(res, await listChanges(after, limit));
});

syncRouter.post('/push', auth, async (req, res) => {
  const parsed = z.object({ clientId: z.string().min(1).max(120), changes: z.array(mutationSchema).max(500) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  return ok(res, await pushChanges(req.user!, parsed.data.clientId, parsed.data.changes as SyncMutation[]));
});
