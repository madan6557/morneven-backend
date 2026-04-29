import express, { Request, Response, NextFunction } from 'express';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { fail, ok } from './utils/response.js';
import { applySecurityMiddleware } from './middleware/security.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authRouter } from './modules/auth/router.js';
import { projectsRouter } from './modules/projects/router.js';
import { loreRouter } from './modules/lore/router.js';
import { galleryRouter } from './modules/gallery/router.js';
import { mapRouter } from './modules/map/router.js';
import { personnelRouter } from './modules/personnel/router.js';
import { settingsRouter } from './modules/settings/router.js';
import { newsRouter } from './modules/news/router.js';
import { filesRouter } from './modules/files/router.js';

const app = express();

app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));
applySecurityMiddleware(app);

if (env.storageDriver === 'local') {
  app.use(env.localStorageBasePath, express.static(env.localStoragePath));
}

app.get('/health', (_req, res) => ok(res, { status: 'ok', env: env.nodeEnv }));
app.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return ok(res, { status: 'ready' });
  } catch {
    return fail(res, 503, 'Database not ready', 'SERVICE_UNAVAILABLE');
  }
});

const mountApiRoutes = (base: string) => {
  app.use(`${base}/auth`, authRouter);
  app.use(`${base}/projects`, projectsRouter);
  app.use(`${base}/lore`, loreRouter);
  app.use(`${base}/gallery`, galleryRouter);
  app.use(`${base}/map`, mapRouter);
  app.use(`${base}/personnel`, personnelRouter);
  app.use(`${base}/settings`, settingsRouter);
  app.use(`${base}/news`, newsRouter);
  app.use(`${base}/files`, filesRouter);
};

mountApiRoutes('/api');
mountApiRoutes('/v1');

app.use((_req, res) => fail(res, 404, 'Route not found', 'NOT_FOUND'));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  return fail(res, 500, 'Server error', 'INTERNAL_SERVER_ERROR');
});

const server = app.listen(env.port, () => {
  console.log(`Morneven backend listening on ${env.port}`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  await prisma.$disconnect();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
