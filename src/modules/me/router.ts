import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { ok } from '../../utils/response.js';
import { getNavigationBadges } from './badges.js';

export const meRouter = Router();

meRouter.get('/navigation-badges', auth, async (req, res) => ok(res, await getNavigationBadges(req.user!)));
