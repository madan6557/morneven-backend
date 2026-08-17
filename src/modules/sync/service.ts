import { randomUUID } from 'node:crypto';
import { EntityType, MediaType, Prisma, SyncAction, SyncEntity } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { canWriteGallery, canWriteLore, canWriteProjects } from '../../middleware/auth.js';
import type { AuthUser } from '../../types/auth.js';
import { normalizeLoreMetadata, normalizeProjectMeta } from '../../utils/lore-contract.js';
import { categoryToEntityType, entityTypeToCategory, projectStatusFromApi, serializeGalleryItem, serializeLoreItem, serializeProject } from '../../utils/serializers.js';

export type SyncMutation = {
  opId: string;
  entity: 'project' | 'lore' | 'gallery';
  id: string;
  action: 'upsert' | 'delete';
  baseSequence: string | null;
  record?: unknown;
};

export type SyncChangeDto = {
  sequence: string;
  entity: 'project' | 'lore' | 'gallery';
  id: string;
  action: 'upsert' | 'delete';
  record: unknown | null;
};

const publicEntity = (entity: SyncEntity): SyncMutation['entity'] => entity as SyncMutation['entity'];
const dbEntity = (entity: SyncMutation['entity']) => entity as SyncEntity;
const dbAction = (action: SyncMutation['action']) => action as SyncAction;

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringValue = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;

const syncRecord = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(syncRecord);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (item === undefined) continue;
    if (['discussions', 'views', 'stars', 'likes', 'dislikes', 'viewerReaction', 'viewerStarred', 'uploadedByStatus'].includes(key)) continue;
    result[key] = syncRecord(item);
  }
  return result;
};

const readRecord = async (entity: SyncMutation['entity'], id: string, db: any): Promise<unknown | null> => {
  if (entity === 'project') {
    const item = await db.project.findUnique({ where: { id }, include: { patches: true } });
    return item ? syncRecord(serializeProject(item)) : null;
  }
  if (entity === 'gallery') {
    const item = await db.galleryItem.findUnique({ where: { id }, include: { tags: true, uploader: true } });
    return item ? syncRecord(serializeGalleryItem(item)) : null;
  }
  const item = await db.loreItem.findUnique({ where: { id } });
  if (!item) return null;
  const docs = await db.entityDoc.findMany({ where: { entityType: item.category, entityId: id } });
  return syncRecord({ ...serializeLoreItem(item, docs), loreCategory: entityTypeToCategory(item.category) });
};

export const appendSyncChange = async (
  db: any,
  input: {
    operationId?: string;
    clientId?: string | null;
    entity: SyncMutation['entity'];
    id: string;
    action: SyncMutation['action'];
    record: unknown | null;
    actorId?: string | null;
  }
) => {
  const change = await db.syncChange.create({
    data: {
      operationId: input.operationId ?? randomUUID(),
      clientId: input.clientId ?? null,
      entity: dbEntity(input.entity),
      entityId: input.id,
      action: dbAction(input.action),
      record: input.record === null ? Prisma.JsonNull : syncRecord(input.record) as Prisma.InputJsonValue,
      actorId: input.actorId ?? null
    }
  });
  return change;
};

const asDocs = (value: unknown) => Array.isArray(value) ? value.map((doc) => {
  const item = objectValue(doc);
  return {
    type: item.type === 'video' ? MediaType.video : item.type === 'file' ? MediaType.file : MediaType.image,
    url: stringValue(item.url),
    thumbnail: stringValue(item.thumbnail) || null,
    caption: stringValue(item.caption),
    date: stringValue(item.date) || null
  };
}) : [];

const applyProject = async (tx: any, id: string, value: unknown) => {
  const record = objectValue(value);
  const patches = Array.isArray(record.patches) ? record.patches : [];
  const data: any = {
    title: stringValue(record.title, 'Untitled project'),
    status: projectStatusFromApi(record.status),
    thumbnail: stringValue(record.thumbnail),
    shortDesc: stringValue(record.shortDesc),
    fullDesc: stringValue(record.fullDesc),
    docs: asDocs(record.docs),
    archived: Boolean(record.archived),
    contributor: typeof record.contributor === 'string' ? record.contributor : null,
    meta: normalizeProjectMeta(record.meta, record.features, record.headerImage) as Prisma.InputJsonObject
  };
  const exists = await tx.project.findUnique({ where: { id }, select: { id: true } });
  if (exists) await tx.project.update({ where: { id }, data });
  else await tx.project.create({ data: { id, ...data } });
  await tx.projectPatch.deleteMany({ where: { projectId: id } });
  if (patches.length) {
    await tx.projectPatch.createMany({
      data: patches.map((patch) => {
        const item = objectValue(patch);
        return { projectId: id, version: stringValue(item.version, '1.0'), patchDate: new Date(stringValue(item.date) || Date.now()), notes: stringValue(item.notes) };
      })
    });
  }
};

const applyLore = async (tx: any, id: string, value: unknown) => {
  const record = objectValue(value);
  const category = stringValue(record.loreCategory || record._category || record.category, 'other');
  const entityType = categoryToEntityType(category) ?? EntityType.other;
  const name = stringValue(record.name || record.title, 'Untitled lore');
  const metadataInput = { ...record };
  delete metadataInput.loreCategory;
  delete metadataInput._category;
  const metadata = normalizeLoreMetadata(entityType, metadataInput) as Prisma.InputJsonObject;
  const data: any = {
    name,
    category: entityType,
    type: stringValue(record.type || record.classification || record.category) || null,
    thumbnail: stringValue(record.thumbnail),
    shortDesc: stringValue(record.shortDesc),
    fullDesc: stringValue(record.fullDesc),
    metadata
  };
  const exists = await tx.loreItem.findUnique({ where: { id }, select: { id: true, category: true } });
  if (exists && exists.category !== entityType) throw new Error('Lore category cannot change during sync.');
  if (exists) await tx.loreItem.update({ where: { id }, data });
  else await tx.loreItem.create({ data: { id, ...data } });
  await tx.contentMetric.upsert({
    where: { entityType_entityId: { entityType, entityId: id } },
    create: { id: `metric-${entityType}-${id}`, entityType, entityId: id },
    update: {}
  });
  await tx.entityDoc.deleteMany({ where: { entityType, entityId: id } });
  const docs = asDocs(record.docs);
  if (docs.length) await tx.entityDoc.createMany({ data: docs.map((doc: any) => ({ ...doc, entityType, entityId: id })) });
};

const applyGallery = async (tx: any, user: AuthUser, id: string, value: unknown) => {
  const record = objectValue(value);
  const data: any = {
    type: record.type === 'video' ? MediaType.video : MediaType.image,
    title: stringValue(record.title, 'Untitled gallery item'),
    thumbnail: stringValue(record.thumbnail),
    mediaUrl: typeof record.mediaUrl === 'string' ? record.mediaUrl : null,
    videoUrl: typeof record.videoUrl === 'string' ? record.videoUrl : null,
    caption: stringValue(record.caption),
    uploadDate: new Date(stringValue(record.date) || Date.now())
  };
  const exists = await tx.galleryItem.findUnique({ where: { id }, select: { id: true } });
  if (exists) await tx.galleryItem.update({ where: { id }, data });
  else await tx.galleryItem.create({ data: { id, ...data, uploadedBy: user.id } });
  await tx.contentMetric.upsert({
    where: { entityType_entityId: { entityType: EntityType.gallery, entityId: id } },
    create: { id: `metric-${EntityType.gallery}-${id}`, entityType: EntityType.gallery, entityId: id },
    update: {}
  });
  await tx.galleryTag.deleteMany({ where: { galleryItemId: id } });
  const tags = Array.isArray(record.tags) ? record.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  if (tags.length) await tx.galleryTag.createMany({ data: tags.map((tag) => ({ galleryItemId: id, tag })) });
};

const deleteEntity = async (tx: any, entity: SyncMutation['entity'], id: string) => {
  const type = dbEntity(entity) as EntityType;
  await tx.entityDoc.deleteMany({ where: { entityType: type, entityId: id } }).catch(() => undefined);
  await tx.comment.deleteMany({ where: { entityType: type, entityId: id } }).catch(() => undefined);
  await tx.contentReaction.deleteMany({ where: { entityType: type, entityId: id } }).catch(() => undefined);
  await tx.contentMetric.deleteMany({ where: { entityType: type, entityId: id } }).catch(() => undefined);
  if (entity === 'project') return tx.project.delete({ where: { id } }).catch(() => undefined);
  if (entity === 'lore') return tx.loreItem.delete({ where: { id } }).catch(() => undefined);
  return tx.galleryItem.delete({ where: { id } }).catch(() => undefined);
};

const canWrite = (user: AuthUser, entity: SyncMutation['entity'], record: unknown) => {
  if (entity === 'project') return canWriteProjects(user);
  if (entity === 'gallery') return canWriteGallery(user);
  const value = objectValue(record);
  if (!record) return user.level >= 7 || (user.level === 6 && user.track === 'executive');
  return canWriteLore(user, stringValue(value.loreCategory || value._category || value.category, 'other'));
};

const validateMutationRecord = (mutation: SyncMutation) => {
  if (mutation.action === 'delete') return;
  const record = objectValue(mutation.record);
  if (!mutation.record || Object.keys(record).length === 0) throw new Error('A record is required for upsert.');
  const required = mutation.entity === 'project'
    ? ['title', 'shortDesc', 'fullDesc']
    : mutation.entity === 'gallery'
      ? ['title', 'caption']
      : ['shortDesc', 'fullDesc'];
  if (required.some((key) => !String(record[key] ?? '').trim())) throw new Error('Sync record is missing required fields.');
  if (mutation.entity === 'lore' && !String(record.name ?? record.title ?? '').trim()) throw new Error('Lore record needs a name or title.');
};

export async function bootstrapSnapshot() {
  return prisma.$transaction(async (tx) => {
    const [cursorRow, projects, lore, gallery] = await Promise.all([
      tx.syncChange.aggregate({ _max: { sequence: true } }),
      tx.project.findMany({ include: { patches: true }, orderBy: { createdAt: 'asc' } }),
      tx.loreItem.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.galleryItem.findMany({ include: { tags: true, uploader: true }, orderBy: { uploadDate: 'asc' } })
    ]);
    const docs = await tx.entityDoc.findMany();
    const docsByKey = new Map<string, typeof docs>();
    for (const doc of docs) docsByKey.set(`${doc.entityType}:${doc.entityId}`, [...(docsByKey.get(`${doc.entityType}:${doc.entityId}`) ?? []), doc]);
    const cursor = cursorRow._max.sequence?.toString() ?? '0';
    return {
      cursor,
      projects: projects.map((item) => syncRecord(serializeProject(item))),
      lore: lore.map((item) => syncRecord({ ...serializeLoreItem(item, docsByKey.get(`${item.category}:${item.id}`) ?? []), loreCategory: entityTypeToCategory(item.category) })),
      gallery: gallery.map((item) => syncRecord(serializeGalleryItem(item)))
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listChanges(after: string, limit: number) {
  const cursor = BigInt(after || '0');
  const rows = await prisma.syncChange.findMany({ where: { sequence: { gt: cursor } }, orderBy: { sequence: 'asc' }, take: Math.min(Math.max(limit, 1), 500) });
  const changes: SyncChangeDto[] = rows.map((row) => ({ sequence: row.sequence.toString(), entity: publicEntity(row.entity), id: row.entityId, action: row.action === SyncAction.delete ? 'delete' : 'upsert', record: row.record === null ? null : row.record }));
  return { changes, nextCursor: changes.at(-1)?.sequence ?? (after || '0'), hasMore: rows.length === Math.min(Math.max(limit, 1), 500) };
}

export async function pushChanges(user: AuthUser, clientId: string, mutations: SyncMutation[]) {
  const applied: Array<{ opId: string; entity: string; id: string; sequence: string; record: unknown | null }> = [];
  const conflicts: Array<{ opId: string; entity: string; id: string; serverSequence: string; serverRecord: unknown | null }> = [];
  const rejected: Array<{ opId: string; reason: string; message: string }> = [];

  for (const mutation of mutations) {
    try {
      const prior = await prisma.syncChange.findUnique({ where: { operationId: mutation.opId } });
      if (prior) {
        applied.push({ opId: mutation.opId, entity: mutation.entity, id: mutation.id, sequence: prior.sequence.toString(), record: prior.record === null ? null : prior.record });
        continue;
      }
      validateMutationRecord(mutation);
      if (!canWrite(user, mutation.entity, mutation.record)) throw new Error('Permission denied for this entity.');
      const result = await prisma.$transaction(async (tx) => {
        if (mutation.entity === 'project' && mutation.action === 'delete' && user.level < 7) throw new Error('Only full-authority authors can delete projects.');
        if (mutation.entity === 'gallery') {
          const existingGallery = await tx.galleryItem.findUnique({ where: { id: mutation.id }, select: { uploadedBy: true } });
          if (existingGallery && user.level < 7 && existingGallery.uploadedBy !== user.id) throw new Error('Only the gallery owner can edit this item.');
        }
        if (mutation.entity === 'lore' && mutation.action === 'delete' && !mutation.record) {
          const existingLore = await tx.loreItem.findUnique({ where: { id: mutation.id }, select: { category: true } });
          if (existingLore && !canWriteLore(user, entityTypeToCategory(existingLore.category))) throw new Error('Permission denied for this lore category.');
        }
        const duplicate = await tx.syncChange.findUnique({ where: { operationId: mutation.opId } });
        if (duplicate) return { kind: 'applied' as const, sequence: duplicate.sequence.toString(), record: duplicate.record === null ? null : duplicate.record };
        const latest = await tx.syncChange.findFirst({ where: { entity: dbEntity(mutation.entity), entityId: mutation.id }, orderBy: { sequence: 'desc' } });
        if (latest && (mutation.baseSequence === null || BigInt(mutation.baseSequence) < latest.sequence)) {
          return { kind: 'conflict' as const, sequence: latest.sequence.toString(), record: latest.record === null ? null : latest.record };
        }
        if (mutation.action === 'delete') await deleteEntity(tx, mutation.entity, mutation.id);
        else if (mutation.entity === 'project') await applyProject(tx, mutation.id, mutation.record);
        else if (mutation.entity === 'lore') await applyLore(tx, mutation.id, mutation.record);
        else await applyGallery(tx, user, mutation.id, mutation.record);
        const record = mutation.action === 'delete' ? null : await readRecord(mutation.entity, mutation.id, tx);
        const change = await appendSyncChange(tx, { operationId: mutation.opId, clientId, entity: mutation.entity, id: mutation.id, action: mutation.action, record, actorId: user.id });
        return { kind: 'applied' as const, sequence: change.sequence.toString(), record };
      });
      if (result.kind === 'conflict') conflicts.push({ opId: mutation.opId, entity: mutation.entity, id: mutation.id, serverSequence: result.sequence, serverRecord: result.record });
      else applied.push({ opId: mutation.opId, entity: mutation.entity, id: mutation.id, sequence: result.sequence, record: result.record });
    } catch (error) {
      rejected.push({ opId: mutation.opId, reason: 'REJECTED', message: error instanceof Error ? error.message : 'Mutation rejected.' });
    }
  }
  return { applied, conflicts, rejected };
}
