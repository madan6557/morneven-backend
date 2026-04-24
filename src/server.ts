import express, { Request, Response, NextFunction } from 'express';
import { env } from './config/env.js';
import { fail, ok } from './utils/response.js';
import { authRouter } from './modules/auth/router.js';
import { projectsRouter } from './modules/projects/router.js';
import { loreRouter } from './modules/lore/router.js';
import { galleryRouter } from './modules/gallery/router.js';
import { mapRouter } from './modules/map/router.js';
import { personnelRouter } from './modules/personnel/router.js';
import { settingsRouter } from './modules/settings/router.js';
import { newsRouter } from './modules/news/router.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => ok(res, { status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/lore', loreRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/map', mapRouter);
app.use('/api/personnel', personnelRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/news', newsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  return fail(res, 500, 'Server error', 'INTERNAL_SERVER_ERROR');
});

app.listen(env.port, () => {
  console.log(`Morneven backend listening on ${env.port}`);
});
