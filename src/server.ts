import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient, EntityType, ProjectStatus, MediaType, MapStatus, Role, Track } from '@prisma/client';
import { z } from 'zod';

dotenv.config();

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

const accessSecret = process.env.JWT_ACCESS_SECRET ?? '<JWT_ACCESS_SECRET_PLACEHOLDER>';
const refreshSecret = process.env.JWT_REFRESH_SECRET ?? '<JWT_REFRESH_SECRET_PLACEHOLDER>';

type AuthUser = { id: string; username: string; role: Role; level: number; track: Track };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ok = (res: express.Response, data: unknown, message?: string) => res.json({ success: true, message, data });
const fail = (res: express.Response, code: number, message: string, errorCode = 'REQUEST_ERROR', errors?: unknown) =>
  res.status(code).json({ success: false, message, errorCode, errors });

const auth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return fail(res, 401, 'Missing token', 'UNAUTHORIZED');
  try {
    const payload = jwt.verify(header.slice(7), accessSecret) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');
    req.user = { id: user.id, username: user.username, role: user.role, level: user.level, track: user.track };
    next();
  } catch {
    return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');
  }
};

const allow = (rule: (u: AuthUser) => boolean) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.user) return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  if (!rule(req.user)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  next();
};

const canWriteNews = (u: AuthUser) => u.level === 7 || (u.level === 6 && u.track === Track.executive);
const canWriteProjects = (u: AuthUser) => u.level === 7 || (u.level === 6 && [Track.mechanic, Track.executive].includes(u.track));
const canWriteLore = (u: AuthUser, category: string) => {
  if (u.level === 7 || (u.level === 6 && u.track === Track.executive)) return true;
  if (u.level !== 6) return false;
  if (category === 'places' || category === 'creatures') return u.track === Track.field;
  if (category === 'technology') return u.track === Track.mechanic;
  return false;
};

app.get('/health', (_req, res) => ok(res, { status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(8), username: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const { email, password, username } = parsed.data;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) return fail(res, 409, 'User already exists', 'CONFLICT');
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, username, passwordHash, role: Role.personel, level: 2, track: Track.executive } });
  await prisma.commandCenterSettings.create({ data: { userId: user.id } });
  return ok(res, { id: user.id, email: user.email, username: user.username, role: user.role, level: user.level, track: user.track }, 'Registered');
});

app.post('/api/auth/login', async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');
  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) return fail(res, 401, 'Invalid credentials', 'UNAUTHORIZED');

  const token = jwt.sign({ sub: user.id }, accessSecret, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ sub: user.id }, refreshSecret, { expiresIn: '7d' });
  await prisma.refreshToken.create({ data: { token: refreshToken, userId: user.id, expiresAt: new Date(Date.now() + 7 * 86400000) } });
  return ok(res, { token, refreshToken, user: { id: user.id, username: user.username, email: user.email, role: user.role, level: user.level, track: user.track, note: user.note } });
});

app.get('/api/auth/me', auth, async (req, res) => ok(res, req.user));
app.post('/api/auth/logout', auth, async (req, res) => {
  await prisma.refreshToken.deleteMany({ where: { userId: req.user!.id } });
  return ok(res, { loggedOut: true });
});
app.post('/api/auth/validate-token', auth, (_req, res) => ok(res, { valid: true }));

app.get('/api/projects', auth, async (_req, res) => ok(res, await prisma.project.findMany({ include: { patches: true } })));
app.get('/api/projects/:id', auth, async (req, res) => ok(res, await prisma.project.findUnique({ where: { id: req.params.id }, include: { patches: true } })));
app.post('/api/projects', auth, allow(canWriteProjects), async (req, res) => {
  const schema = z.object({ title: z.string(), status: z.nativeEnum(ProjectStatus), thumbnail: z.string(), shortDesc: z.string(), fullDesc: z.string() });
  const p = schema.safeParse(req.body);
  if (!p.success) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', p.error.flatten());
  return res.status(201).json({ success: true, data: await prisma.project.create({ data: p.data }) });
});
app.put('/api/projects/:id', auth, allow(canWriteProjects), async (req, res) => ok(res, await prisma.project.update({ where: { id: req.params.id }, data: req.body })));
app.delete('/api/projects/:id', auth, allow(canWriteProjects), async (req, res) => ok(res, await prisma.project.delete({ where: { id: req.params.id } })));

app.get('/api/lore/:category', auth, async (req, res) => ok(res, await prisma.loreItem.findMany({ where: { category: req.params.category.slice(0, -1) as EntityType } })));
app.get('/api/lore/:category/:id', auth, async (req, res) => ok(res, await prisma.loreItem.findUnique({ where: { id: req.params.id } })));
app.post('/api/lore/:category', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return res.status(201).json({ success: true, data: await prisma.loreItem.create({ data: { ...req.body, category: req.params.category.slice(0, -1) as EntityType } }) });
});
app.put('/api/lore/:category/:id', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.loreItem.update({ where: { id: req.params.id }, data: req.body }));
});
app.delete('/api/lore/:category/:id', auth, async (req, res) => {
  if (!canWriteLore(req.user!, req.params.category)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.loreItem.delete({ where: { id: req.params.id } }));
});

app.get('/api/gallery', auth, async (_req, res) => ok(res, await prisma.galleryItem.findMany({ include: { tags: true } })));
app.get('/api/gallery/:id', auth, async (req, res) => ok(res, await prisma.galleryItem.findUnique({ where: { id: req.params.id }, include: { tags: true } })));
app.post('/api/gallery', auth, allow((u) => u.level >= 6 && u.role !== Role.guest), async (req, res) => {
  const data = { ...req.body, uploadedBy: req.user!.id, type: (req.body.type ?? 'image') as MediaType };
  return res.status(201).json({ success: true, data: await prisma.galleryItem.create({ data }) });
});
app.put('/api/gallery/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.galleryItem.update({ where: { id: req.params.id }, data: req.body }));
});
app.delete('/api/gallery/:id', auth, async (req, res) => {
  const item = await prisma.galleryItem.findUnique({ where: { id: req.params.id } });
  if (!item) return fail(res, 404, 'Not found', 'NOT_FOUND');
  if (!(req.user!.level === 7 || item.uploadedBy === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.galleryItem.delete({ where: { id: req.params.id } }));
});

app.post('/api/gallery/:id/comments', auth, async (req, res) => res.status(201).json({ success: true, data: await prisma.comment.create({ data: { entityType: EntityType.gallery, entityId: req.params.id, authorId: req.user!.id, text: req.body.text } }) }));
app.post('/api/gallery/:id/comments/:commentId/replies', auth, async (req, res) => res.status(201).json({ success: true, data: await prisma.reply.create({ data: { commentId: req.params.commentId, authorId: req.user!.id, text: req.body.text } }) }));
app.put('/api/gallery/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment) return fail(res, 404, 'Not found', 'NOT_FOUND');
  const canModerate = req.user!.level === 7 || (req.user!.level === 6 && req.user!.track === Track.executive);
  if (!(canModerate || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.comment.update({ where: { id: comment.id }, data: { text: req.body.text } }));
});
app.delete('/api/gallery/:id/comments/:commentId', auth, async (req, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId } });
  if (!comment) return fail(res, 404, 'Not found', 'NOT_FOUND');
  const canModerate = req.user!.level === 7 || (req.user!.level === 6 && req.user!.track === Track.executive);
  if (!(canModerate || comment.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.comment.delete({ where: { id: comment.id } }));
});
app.put('/api/gallery/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId } });
  if (!reply) return fail(res, 404, 'Not found', 'NOT_FOUND');
  const canModerate = req.user!.level === 7 || (req.user!.level === 6 && req.user!.track === Track.executive);
  if (!(canModerate || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.reply.update({ where: { id: reply.id }, data: { text: req.body.text } }));
});
app.delete('/api/gallery/:id/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  const reply = await prisma.reply.findUnique({ where: { id: req.params.replyId } });
  if (!reply) return fail(res, 404, 'Not found', 'NOT_FOUND');
  const canModerate = req.user!.level === 7 || (req.user!.level === 6 && req.user!.track === Track.executive);
  if (!(canModerate || reply.authorId === req.user!.id)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return ok(res, await prisma.reply.delete({ where: { id: reply.id } }));
});

app.get('/api/map/markers', auth, async (_req, res) => ok(res, await prisma.mapMarker.findMany()));
app.put('/api/map/markers', auth, allow((u) => u.level === 7), async (req, res) => {
  await prisma.mapMarker.deleteMany();
  await prisma.mapMarker.createMany({ data: req.body.markers as Array<{ name: string; status: MapStatus; x: number; y: number; description: string; loreLink?: string }> });
  return ok(res, await prisma.mapMarker.findMany());
});
app.get('/api/map/image', auth, async (_req, res) => ok(res, await prisma.mapImage.findUnique({ where: { id: 'main' } })));
app.put('/api/map/image', auth, allow((u) => u.level === 7), async (req, res) => ok(res, await prisma.mapImage.upsert({ where: { id: 'main' }, update: { imageUrl: req.body.imageUrl }, create: { id: 'main', imageUrl: req.body.imageUrl } })));

app.get('/api/personnel', auth, allow((u) => u.level === 7), async (_req, res) => ok(res, await prisma.user.findMany()));
app.get('/api/personnel/:id', auth, allow((u) => u.level === 7), async (req, res) => ok(res, await prisma.user.findUnique({ where: { id: req.params.id } })));
app.post('/api/personnel', auth, allow((u) => u.level === 7), async (req, res) => {
  const passwordHash = await bcrypt.hash(req.body.password ?? 'secret123', 10);
  return res.status(201).json({ success: true, data: await prisma.user.create({ data: { username: req.body.username, email: req.body.email, passwordHash, role: req.body.role, level: req.body.level, track: req.body.track, note: req.body.note } }) });
});
app.put('/api/personnel/:id', auth, allow((u) => u.level === 7), async (req, res) => ok(res, await prisma.user.update({ where: { id: req.params.id }, data: req.body })));
app.delete('/api/personnel/:id', auth, allow((u) => u.level === 7), async (req, res) => ok(res, await prisma.user.delete({ where: { id: req.params.id } })));
app.patch('/api/personnel/bulk', auth, allow((u) => u.level === 7), async (req, res) => {
  const updates = req.body.updates as Array<{ id: string; level?: number; track?: Track; role?: Role; note?: string }>;
  await Promise.all(updates.map((u) => prisma.user.update({ where: { id: u.id }, data: u })));
  return ok(res, { updated: updates.length });
});

app.get('/api/settings/command-center', auth, async (req, res) => ok(res, await prisma.commandCenterSettings.findUnique({ where: { userId: req.user!.id } })));
app.put('/api/settings/command-center', auth, async (req, res) => ok(res, await prisma.commandCenterSettings.upsert({ where: { userId: req.user!.id }, update: req.body, create: { userId: req.user!.id, ...req.body } })));

app.get('/api/news', auth, async (_req, res) => ok(res, await prisma.news.findMany({ include: { attachments: true } })));
app.post('/api/news', auth, allow(canWriteNews), async (req, res) => res.status(201).json({ success: true, data: await prisma.news.create({ data: { ...req.body, authorId: req.user!.id, publishDate: req.body.publishDate ? new Date(req.body.publishDate) : new Date() } }) }));
app.put('/api/news/:id', auth, allow(canWriteNews), async (req, res) => ok(res, await prisma.news.update({ where: { id: req.params.id }, data: req.body })));
app.delete('/api/news/:id', auth, allow(canWriteNews), async (req, res) => ok(res, await prisma.news.delete({ where: { id: req.params.id } })));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  return fail(res, 500, 'Server error', 'INTERNAL_SERVER_ERROR');
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Morneven backend listening on ${port}`);
});
