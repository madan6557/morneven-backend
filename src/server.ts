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
import { managementRouter } from './modules/management/router.js';
import { notificationsRouter } from './modules/notifications/router.js';
import { chatRouter } from './modules/chat/router.js';
import { meRouter } from './modules/me/router.js';
import { contentStatsRouter } from './modules/content-stats/router.js';
import { commandCenterRouter } from './modules/command-center/router.js';
import { attachRealtimeWebSocket } from './realtime/websocket.js';

const app = express();

app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));
applySecurityMiddleware(app);

if (env.storageDriver === 'local') {
  app.use(env.localStorageBasePath, express.static(env.localStoragePath));
}

const healthHandler = (_req: Request, res: Response) => ok(res, { status: 'ok', env: env.nodeEnv });
const readyHandler = async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return ok(res, { status: 'ready' });
  } catch {
    return fail(res, 503, 'Database not ready', 'SERVICE_UNAVAILABLE');
  }
};

app.get('/health', healthHandler);
app.get('/ready', readyHandler);
app.get('/api/health', healthHandler);
app.get('/api/ready', readyHandler);
app.get('/v1/health', healthHandler);
app.get('/v1/ready', readyHandler);

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
  app.use(`${base}/mgmt`, managementRouter);
  app.use(`${base}/management`, managementRouter);
  app.use(`${base}/notifications`, notificationsRouter);
  app.use(`${base}/chat`, chatRouter);
  app.use(`${base}/me`, meRouter);
  app.use(`${base}/content-stats`, contentStatsRouter);
  app.use(`${base}/command-center`, commandCenterRouter);
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

attachRealtimeWebSocket(server);

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
