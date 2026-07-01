import { EntityType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import {
  serializeGalleryItem,
  serializeLoreItem,
  serializeNewsItem,
  serializeProject,
  serializeUser
} from './serializers.js';
import { collectReferencedStoragePaths } from './storage-cleanup.js';

const passwordResetRequestModel = (prisma as any).passwordResetRequest as {
  findMany: (args?: Record<string, unknown>) => Promise<any[]>;
  count: () => Promise<number>;
};

const isLegacyRuntimeArchivePath = (value: string) => {
  const normalized = value.trim().replace(/^\/+/, '').toLowerCase();
  return normalized.startsWith('legacy/nanobot/') || normalized.includes('/legacy/nanobot/');
};

const activeArtifactWhere = () => ({ expiresAt: { gt: new Date() } });

const findActiveBotManagerIdentityFiles = async () => {
  const files = await prisma.botManagerIdentityFile.findMany();
  return files.filter((file) => !isLegacyRuntimeArchivePath(file.path) && !isLegacyRuntimeArchivePath(file.objectPath));
};

const countActiveBotManagerIdentityFiles = async () => (await findActiveBotManagerIdentityFiles()).length;

export type ExportSnapshot = {
  characters: ReturnType<typeof serializeLoreItem>[];
  creatures: ReturnType<typeof serializeLoreItem>[];
  places: ReturnType<typeof serializeLoreItem>[];
  projects: ReturnType<typeof serializeProject>[];
  technology: ReturnType<typeof serializeLoreItem>[];
  events: ReturnType<typeof serializeLoreItem>[];
  others: ReturnType<typeof serializeLoreItem>[];
  gallery: ReturnType<typeof serializeGalleryItem>[];
  news: Array<{
    id: string;
    text: string;
    date: string;
    createdAt: string;
    hasDetail: boolean;
    thumbnail?: string;
    body?: string;
    attachments: Array<{ type: 'image' | 'video' | 'link'; url: string; caption?: string }>;
  }>;
  personnel: ReturnType<typeof serializeUser>[];
  passwordResetRequests: Array<{
    id: string;
    email: string;
    username: string;
    identityProof: string;
    status: string;
    reviewNote?: string;
    reviewedBy?: string;
    newPasswordHash: string;
    createdAt: string;
    updatedAt: string;
    reviewedAt?: string;
    completedAt?: string;
  }>;
  personnelReports: Array<{
    id: string;
    reporterUsername: string;
    targetUsername: string;
    category: string;
    details: string;
    status: string;
    resolutionAction?: string;
    resolutionNote?: string;
    resolvedByUsername?: string;
    createdAt: string;
    updatedAt: string;
    resolvedAt?: string;
  }>;
  contentMetrics: Awaited<ReturnType<typeof prisma.contentMetric.findMany>>;
  contentViewEvents: Awaited<ReturnType<typeof prisma.contentViewEvent.findMany>>;
  siteVisitEvents: Awaited<ReturnType<typeof prisma.siteVisitEvent.findMany>>;
  contentReactions: Awaited<ReturnType<typeof prisma.contentReaction.findMany>>;
  map: {
    mapImage: string;
    markers: Awaited<ReturnType<typeof prisma.mapMarker.findMany>>;
  };
  botManager: {
    credentials: Awaited<ReturnType<typeof prisma.botManagerCredential.findMany>>;
    openRouterProfiles: Awaited<ReturnType<typeof prisma.botManagerOpenRouterProfile.findMany>>;
    analyticsCredentials: Awaited<ReturnType<typeof prisma.botManagerProviderAnalyticsCredential.findMany>>;
    usageEvents: Awaited<ReturnType<typeof prisma.botManagerProviderUsageEvent.findMany>>;
    backupJobs: Awaited<ReturnType<typeof prisma.botManagerBackupJob.findMany>>;
    generalConfig: Awaited<ReturnType<typeof prisma.botManagerGeneralConfig.findMany>>;
    identities: Awaited<ReturnType<typeof prisma.botManagerIdentity.findMany>>;
    files: Awaited<ReturnType<typeof prisma.botManagerIdentityFile.findMany>>;
  };
};

export type MigrationDataset = {
  users: Awaited<ReturnType<typeof prisma.user.findMany>>;
  passwordResetRequests: any[];
  commandCenterSettings: Awaited<ReturnType<typeof prisma.commandCenterSettings.findMany>>;
  botManagerCredentials: Awaited<ReturnType<typeof prisma.botManagerCredential.findMany>>;
  botManagerOpenRouterProfiles: Awaited<ReturnType<typeof prisma.botManagerOpenRouterProfile.findMany>>;
  botManagerProviderAnalyticsCredentials: Awaited<ReturnType<typeof prisma.botManagerProviderAnalyticsCredential.findMany>>;
  botManagerProviderUsageEvents: Awaited<ReturnType<typeof prisma.botManagerProviderUsageEvent.findMany>>;
  botManagerBackupJobs: Awaited<ReturnType<typeof prisma.botManagerBackupJob.findMany>>;
  botManagerGeneralConfigs: Awaited<ReturnType<typeof prisma.botManagerGeneralConfig.findMany>>;
  botManagerIdentities: Awaited<ReturnType<typeof prisma.botManagerIdentity.findMany>>;
  botManagerIdentityFiles: Awaited<ReturnType<typeof prisma.botManagerIdentityFile.findMany>>;
  securitySessions: Awaited<ReturnType<typeof prisma.securitySession.findMany>>;
  siteVisitEvents: Awaited<ReturnType<typeof prisma.siteVisitEvent.findMany>>;
  refreshTokens: Awaited<ReturnType<typeof prisma.refreshToken.findMany>>;
  projects: Awaited<ReturnType<typeof prisma.project.findMany>>;
  projectPatches: Awaited<ReturnType<typeof prisma.projectPatch.findMany>>;
  news: Awaited<ReturnType<typeof prisma.news.findMany>>;
  newsAttachments: Awaited<ReturnType<typeof prisma.newsAttachment.findMany>>;
  loreItems: Awaited<ReturnType<typeof prisma.loreItem.findMany>>;
  entityDocs: Awaited<ReturnType<typeof prisma.entityDoc.findMany>>;
  galleryItems: Awaited<ReturnType<typeof prisma.galleryItem.findMany>>;
  galleryTags: Awaited<ReturnType<typeof prisma.galleryTag.findMany>>;
  mapImages: Awaited<ReturnType<typeof prisma.mapImage.findMany>>;
  mapMarkers: Awaited<ReturnType<typeof prisma.mapMarker.findMany>>;
  comments: Awaited<ReturnType<typeof prisma.comment.findMany>>;
  replies: Awaited<ReturnType<typeof prisma.reply.findMany>>;
  mentions: Awaited<ReturnType<typeof prisma.mention.findMany>>;
  contentMetrics: Awaited<ReturnType<typeof prisma.contentMetric.findMany>>;
  contentViewEvents: Awaited<ReturnType<typeof prisma.contentViewEvent.findMany>>;
  contentReactions: Awaited<ReturnType<typeof prisma.contentReaction.findMany>>;
  managementRequests: Awaited<ReturnType<typeof prisma.managementRequest.findMany>>;
  teams: Awaited<ReturnType<typeof prisma.team.findMany>>;
  quotaRecords: Awaited<ReturnType<typeof prisma.quotaRecord.findMany>>;
  notifications: Awaited<ReturnType<typeof prisma.notification.findMany>>;
  notificationReads: Awaited<ReturnType<typeof prisma.notificationRead.findMany>>;
  chatConversations: Awaited<ReturnType<typeof prisma.chatConversation.findMany>>;
  chatConversationMembers: Awaited<ReturnType<typeof prisma.chatConversationMember.findMany>>;
  chatMessages: Awaited<ReturnType<typeof prisma.chatMessage.findMany>>;
  chatReadStates: Awaited<ReturnType<typeof prisma.chatReadState.findMany>>;
  extractionJobs: Awaited<ReturnType<typeof prisma.extractionJob.findMany>>;
  auditLogs: Awaited<ReturnType<typeof prisma.auditLog.findMany>>;
  securityEvents: Awaited<ReturnType<typeof prisma.securityEvent.findMany>>;
  securityBlocks: Awaited<ReturnType<typeof prisma.securityBlock.findMany>>;
  securityPolicies: Awaited<ReturnType<typeof prisma.securityPolicy.findMany>>;
  fileScanRecords: Awaited<ReturnType<typeof prisma.fileScanRecord.findMany>>;
  personnelReports: Awaited<ReturnType<typeof prisma.personnelReport.findMany>>;
};

export type MigrationPayload = {
  version: 1;
  exportedAt: string;
  source: {
    assetEndpoint: string;
  };
  dataset: MigrationDataset;
  assets: Array<{ objectPath: string }>;
  summary: {
    tables: Record<string, number>;
    assetCount: number;
  };
};

export type MigrationVerification = {
  tables: Record<string, number>;
  assetCount: number;
  uploadedAssetCount: number;
  failedAssets: Array<{ objectPath: string; error: string }>;
};

type MigrationTableKey = keyof MigrationDataset;
type MigrationTableContract = {
  key: MigrationTableKey;
  sqlTable: string;
  findMany: () => Promise<any[]>;
  count: () => Promise<number>;
  deleteMany: (tx: Prisma.TransactionClient) => Promise<unknown>;
  createMany: (tx: Prisma.TransactionClient, rows: any[]) => Promise<unknown>;
};

export const MIGRATION_TABLES: MigrationTableContract[] = [
  { key: 'users', sqlTable: 'User', findMany: () => prisma.user.findMany(), count: () => prisma.user.count(), deleteMany: (tx) => tx.user.deleteMany(), createMany: (tx, rows) => tx.user.createMany({ data: rows }) },
  { key: 'securitySessions', sqlTable: 'SecuritySession', findMany: () => prisma.securitySession.findMany(), count: () => prisma.securitySession.count(), deleteMany: (tx) => tx.securitySession.deleteMany(), createMany: (tx, rows) => tx.securitySession.createMany({ data: rows }) },
  { key: 'siteVisitEvents', sqlTable: 'SiteVisitEvent', findMany: () => prisma.siteVisitEvent.findMany(), count: () => prisma.siteVisitEvent.count(), deleteMany: (tx) => tx.siteVisitEvent.deleteMany(), createMany: (tx, rows) => tx.siteVisitEvent.createMany({ data: rows }) },
  { key: 'passwordResetRequests', sqlTable: 'PasswordResetRequest', findMany: () => passwordResetRequestModel.findMany(), count: () => passwordResetRequestModel.count(), deleteMany: (tx) => (tx as any).passwordResetRequest.deleteMany(), createMany: (tx, rows) => (tx as any).passwordResetRequest.createMany({ data: rows }) },
  { key: 'commandCenterSettings', sqlTable: 'CommandCenterSettings', findMany: () => prisma.commandCenterSettings.findMany(), count: () => prisma.commandCenterSettings.count(), deleteMany: (tx) => tx.commandCenterSettings.deleteMany(), createMany: (tx, rows) => tx.commandCenterSettings.createMany({ data: rows }) },
  { key: 'botManagerCredentials', sqlTable: 'BotManagerCredential', findMany: () => prisma.botManagerCredential.findMany(), count: () => prisma.botManagerCredential.count(), deleteMany: (tx) => tx.botManagerCredential.deleteMany(), createMany: (tx, rows) => tx.botManagerCredential.createMany({ data: rows }) },
  { key: 'botManagerOpenRouterProfiles', sqlTable: 'BotManagerOpenRouterProfile', findMany: () => prisma.botManagerOpenRouterProfile.findMany(), count: () => prisma.botManagerOpenRouterProfile.count(), deleteMany: (tx) => tx.botManagerOpenRouterProfile.deleteMany(), createMany: (tx, rows) => tx.botManagerOpenRouterProfile.createMany({ data: rows }) },
  { key: 'botManagerProviderAnalyticsCredentials', sqlTable: 'BotManagerProviderAnalyticsCredential', findMany: () => prisma.botManagerProviderAnalyticsCredential.findMany(), count: () => prisma.botManagerProviderAnalyticsCredential.count(), deleteMany: (tx) => tx.botManagerProviderAnalyticsCredential.deleteMany(), createMany: (tx, rows) => tx.botManagerProviderAnalyticsCredential.createMany({ data: rows }) },
  { key: 'botManagerProviderUsageEvents', sqlTable: 'BotManagerProviderUsageEvent', findMany: () => prisma.botManagerProviderUsageEvent.findMany(), count: () => prisma.botManagerProviderUsageEvent.count(), deleteMany: (tx) => tx.botManagerProviderUsageEvent.deleteMany(), createMany: (tx, rows) => tx.botManagerProviderUsageEvent.createMany({ data: rows, skipDuplicates: true }) },
  { key: 'botManagerGeneralConfigs', sqlTable: 'BotManagerGeneralConfig', findMany: () => prisma.botManagerGeneralConfig.findMany(), count: () => prisma.botManagerGeneralConfig.count(), deleteMany: (tx) => tx.botManagerGeneralConfig.deleteMany(), createMany: (tx, rows) => tx.botManagerGeneralConfig.createMany({ data: rows }) },
  { key: 'botManagerIdentities', sqlTable: 'BotManagerIdentity', findMany: () => prisma.botManagerIdentity.findMany(), count: () => prisma.botManagerIdentity.count(), deleteMany: (tx) => tx.botManagerIdentity.deleteMany(), createMany: (tx, rows) => tx.botManagerIdentity.createMany({ data: rows }) },
  { key: 'botManagerIdentityFiles', sqlTable: 'BotManagerIdentityFile', findMany: findActiveBotManagerIdentityFiles, count: countActiveBotManagerIdentityFiles, deleteMany: (tx) => tx.botManagerIdentityFile.deleteMany(), createMany: (tx, rows) => tx.botManagerIdentityFile.createMany({ data: rows }) },
  { key: 'botManagerBackupJobs', sqlTable: 'BotManagerBackupJob', findMany: () => prisma.botManagerBackupJob.findMany({ where: activeArtifactWhere() }), count: () => prisma.botManagerBackupJob.count({ where: activeArtifactWhere() }), deleteMany: (tx) => tx.botManagerBackupJob.deleteMany(), createMany: (tx, rows) => tx.botManagerBackupJob.createMany({ data: rows }) },
  { key: 'refreshTokens', sqlTable: 'RefreshToken', findMany: () => prisma.refreshToken.findMany(), count: () => prisma.refreshToken.count(), deleteMany: (tx) => tx.refreshToken.deleteMany(), createMany: (tx, rows) => tx.refreshToken.createMany({ data: rows }) },
  { key: 'projects', sqlTable: 'Project', findMany: () => prisma.project.findMany(), count: () => prisma.project.count(), deleteMany: (tx) => tx.project.deleteMany(), createMany: (tx, rows) => tx.project.createMany({ data: rows }) },
  { key: 'projectPatches', sqlTable: 'ProjectPatch', findMany: () => prisma.projectPatch.findMany(), count: () => prisma.projectPatch.count(), deleteMany: (tx) => tx.projectPatch.deleteMany(), createMany: (tx, rows) => tx.projectPatch.createMany({ data: rows }) },
  { key: 'news', sqlTable: 'News', findMany: () => prisma.news.findMany(), count: () => prisma.news.count(), deleteMany: (tx) => tx.news.deleteMany(), createMany: (tx, rows) => tx.news.createMany({ data: rows }) },
  { key: 'newsAttachments', sqlTable: 'NewsAttachment', findMany: () => prisma.newsAttachment.findMany(), count: () => prisma.newsAttachment.count(), deleteMany: (tx) => tx.newsAttachment.deleteMany(), createMany: (tx, rows) => tx.newsAttachment.createMany({ data: rows }) },
  { key: 'loreItems', sqlTable: 'LoreItem', findMany: () => prisma.loreItem.findMany(), count: () => prisma.loreItem.count(), deleteMany: (tx) => tx.loreItem.deleteMany(), createMany: (tx, rows) => tx.loreItem.createMany({ data: rows }) },
  { key: 'entityDocs', sqlTable: 'EntityDoc', findMany: () => prisma.entityDoc.findMany(), count: () => prisma.entityDoc.count(), deleteMany: (tx) => tx.entityDoc.deleteMany(), createMany: (tx, rows) => tx.entityDoc.createMany({ data: rows }) },
  { key: 'galleryItems', sqlTable: 'GalleryItem', findMany: () => prisma.galleryItem.findMany(), count: () => prisma.galleryItem.count(), deleteMany: (tx) => tx.galleryItem.deleteMany(), createMany: (tx, rows) => tx.galleryItem.createMany({ data: rows }) },
  { key: 'galleryTags', sqlTable: 'GalleryTag', findMany: () => prisma.galleryTag.findMany(), count: () => prisma.galleryTag.count(), deleteMany: (tx) => tx.galleryTag.deleteMany(), createMany: (tx, rows) => tx.galleryTag.createMany({ data: rows }) },
  { key: 'mapImages', sqlTable: 'MapImage', findMany: () => prisma.mapImage.findMany(), count: () => prisma.mapImage.count(), deleteMany: (tx) => tx.mapImage.deleteMany(), createMany: (tx, rows) => tx.mapImage.createMany({ data: rows }) },
  { key: 'mapMarkers', sqlTable: 'MapMarker', findMany: () => prisma.mapMarker.findMany(), count: () => prisma.mapMarker.count(), deleteMany: (tx) => tx.mapMarker.deleteMany(), createMany: (tx, rows) => tx.mapMarker.createMany({ data: rows }) },
  { key: 'comments', sqlTable: 'Comment', findMany: () => prisma.comment.findMany(), count: () => prisma.comment.count(), deleteMany: (tx) => tx.comment.deleteMany(), createMany: (tx, rows) => tx.comment.createMany({ data: rows }) },
  { key: 'replies', sqlTable: 'Reply', findMany: () => prisma.reply.findMany(), count: () => prisma.reply.count(), deleteMany: (tx) => tx.reply.deleteMany(), createMany: (tx, rows) => tx.reply.createMany({ data: rows }) },
  { key: 'mentions', sqlTable: 'Mention', findMany: () => prisma.mention.findMany(), count: () => prisma.mention.count(), deleteMany: (tx) => tx.mention.deleteMany(), createMany: (tx, rows) => tx.mention.createMany({ data: rows }) },
  { key: 'contentMetrics', sqlTable: 'ContentMetric', findMany: () => prisma.contentMetric.findMany(), count: () => prisma.contentMetric.count(), deleteMany: (tx) => tx.contentMetric.deleteMany(), createMany: (tx, rows) => tx.contentMetric.createMany({ data: rows }) },
  { key: 'contentViewEvents', sqlTable: 'ContentViewEvent', findMany: () => prisma.contentViewEvent.findMany(), count: () => prisma.contentViewEvent.count(), deleteMany: (tx) => tx.contentViewEvent.deleteMany(), createMany: (tx, rows) => tx.contentViewEvent.createMany({ data: rows }) },
  { key: 'contentReactions', sqlTable: 'ContentReaction', findMany: () => prisma.contentReaction.findMany(), count: () => prisma.contentReaction.count(), deleteMany: (tx) => tx.contentReaction.deleteMany(), createMany: (tx, rows) => tx.contentReaction.createMany({ data: rows }) },
  { key: 'managementRequests', sqlTable: 'ManagementRequest', findMany: () => prisma.managementRequest.findMany(), count: () => prisma.managementRequest.count(), deleteMany: (tx) => tx.managementRequest.deleteMany(), createMany: (tx, rows) => tx.managementRequest.createMany({ data: rows }) },
  { key: 'teams', sqlTable: 'Team', findMany: () => prisma.team.findMany(), count: () => prisma.team.count(), deleteMany: (tx) => tx.team.deleteMany(), createMany: (tx, rows) => tx.team.createMany({ data: rows }) },
  { key: 'quotaRecords', sqlTable: 'QuotaRecord', findMany: () => prisma.quotaRecord.findMany(), count: () => prisma.quotaRecord.count(), deleteMany: (tx) => tx.quotaRecord.deleteMany(), createMany: (tx, rows) => tx.quotaRecord.createMany({ data: rows }) },
  { key: 'notifications', sqlTable: 'Notification', findMany: () => prisma.notification.findMany(), count: () => prisma.notification.count(), deleteMany: (tx) => tx.notification.deleteMany(), createMany: (tx, rows) => tx.notification.createMany({ data: rows }) },
  { key: 'notificationReads', sqlTable: 'NotificationRead', findMany: () => prisma.notificationRead.findMany(), count: () => prisma.notificationRead.count(), deleteMany: (tx) => tx.notificationRead.deleteMany(), createMany: (tx, rows) => tx.notificationRead.createMany({ data: rows }) },
  { key: 'chatConversations', sqlTable: 'ChatConversation', findMany: () => prisma.chatConversation.findMany(), count: () => prisma.chatConversation.count(), deleteMany: (tx) => tx.chatConversation.deleteMany(), createMany: (tx, rows) => tx.chatConversation.createMany({ data: rows }) },
  { key: 'chatConversationMembers', sqlTable: 'ChatConversationMember', findMany: () => prisma.chatConversationMember.findMany(), count: () => prisma.chatConversationMember.count(), deleteMany: (tx) => tx.chatConversationMember.deleteMany(), createMany: (tx, rows) => tx.chatConversationMember.createMany({ data: rows }) },
  { key: 'chatMessages', sqlTable: 'ChatMessage', findMany: () => prisma.chatMessage.findMany(), count: () => prisma.chatMessage.count(), deleteMany: (tx) => tx.chatMessage.deleteMany(), createMany: (tx, rows) => tx.chatMessage.createMany({ data: rows }) },
  { key: 'chatReadStates', sqlTable: 'ChatReadState', findMany: () => prisma.chatReadState.findMany(), count: () => prisma.chatReadState.count(), deleteMany: (tx) => tx.chatReadState.deleteMany(), createMany: (tx, rows) => tx.chatReadState.createMany({ data: rows }) },
  { key: 'extractionJobs', sqlTable: 'ExtractionJob', findMany: () => prisma.extractionJob.findMany({ where: activeArtifactWhere() }), count: () => prisma.extractionJob.count({ where: activeArtifactWhere() }), deleteMany: (tx) => tx.extractionJob.deleteMany(), createMany: (tx, rows) => tx.extractionJob.createMany({ data: rows }) },
  { key: 'auditLogs', sqlTable: 'AuditLog', findMany: () => prisma.auditLog.findMany({ where: { action: { not: 'migration.job' } } }), count: () => prisma.auditLog.count({ where: { action: { not: 'migration.job' } } }), deleteMany: (tx) => tx.auditLog.deleteMany({ where: { action: { not: 'migration.job' } } }), createMany: (tx, rows) => tx.auditLog.createMany({ data: rows }) },
  { key: 'securityEvents', sqlTable: 'SecurityEvent', findMany: () => prisma.securityEvent.findMany(), count: () => prisma.securityEvent.count(), deleteMany: (tx) => tx.securityEvent.deleteMany(), createMany: (tx, rows) => tx.securityEvent.createMany({ data: rows }) },
  { key: 'securityBlocks', sqlTable: 'SecurityBlock', findMany: () => prisma.securityBlock.findMany(), count: () => prisma.securityBlock.count(), deleteMany: (tx) => tx.securityBlock.deleteMany(), createMany: (tx, rows) => tx.securityBlock.createMany({ data: rows }) },
  { key: 'securityPolicies', sqlTable: 'SecurityPolicy', findMany: () => prisma.securityPolicy.findMany(), count: () => prisma.securityPolicy.count(), deleteMany: (tx) => tx.securityPolicy.deleteMany(), createMany: (tx, rows) => tx.securityPolicy.createMany({ data: rows }) },
  { key: 'fileScanRecords', sqlTable: 'FileScanRecord', findMany: () => prisma.fileScanRecord.findMany(), count: () => prisma.fileScanRecord.count(), deleteMany: (tx) => tx.fileScanRecord.deleteMany(), createMany: (tx, rows) => tx.fileScanRecord.createMany({ data: rows }) },
  { key: 'personnelReports', sqlTable: 'PersonnelReport', findMany: () => prisma.personnelReport.findMany(), count: () => prisma.personnelReport.count(), deleteMany: (tx) => tx.personnelReport.deleteMany(), createMany: (tx, rows) => tx.personnelReport.createMany({ data: rows }) }
];

const serializePasswordResetRequestForExtraction = (
  item: {
    id: string;
    email: string;
    username: string;
    identityProof: string;
    status: string;
    reviewNote?: string | null;
    reviewedBy?: { username: string } | null;
    newPasswordHash: string;
    createdAt: Date;
    updatedAt: Date;
    reviewedAt?: Date | null;
    completedAt?: Date | null;
  }
): ExportSnapshot['passwordResetRequests'][number] => ({
  id: item.id,
  email: item.email,
  username: item.username,
  identityProof: item.identityProof,
  status: item.status,
  reviewNote: item.reviewNote ?? undefined,
  reviewedBy: item.reviewedBy?.username ?? undefined,
  newPasswordHash: item.newPasswordHash,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  reviewedAt: item.reviewedAt?.toISOString(),
  completedAt: item.completedAt?.toISOString()
});

const serializePersonnelReportForExtraction = (
  item: Prisma.PersonnelReportGetPayload<{ include: { reporter: true; target: true; resolvedBy: true } }>
): ExportSnapshot['personnelReports'][number] => ({
  id: item.id,
  reporterUsername: item.reporter.username,
  targetUsername: item.target.username,
  category: item.category,
  details: item.details,
  status: item.status,
  resolutionAction: item.resolutionAction ?? undefined,
  resolutionNote: item.resolutionNote ?? undefined,
  resolvedByUsername: item.resolvedBy?.username ?? undefined,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
  resolvedAt: item.resolvedAt?.toISOString()
});

export const collectExtractionSnapshot = async (): Promise<ExportSnapshot> => {
  const [
    projects,
    gallery,
    news,
    personnel,
    passwordResetRequests,
    personnelReports,
    contentMetrics,
    contentViewEvents,
    siteVisitEvents,
    contentReactions,
    mapMarkers,
    mapImage,
    botManagerCredentials,
    botManagerOpenRouterProfiles,
    botManagerProviderAnalyticsCredentials,
    botManagerProviderUsageEvents,
    botManagerBackupJobs,
    botManagerGeneralConfig,
    botManagerIdentities,
    botManagerFiles,
    lore,
    docs
  ] = await Promise.all([
    prisma.project.findMany({ include: { patches: true } }),
    prisma.galleryItem.findMany({ include: { tags: true, uploader: true } }),
    prisma.news.findMany({ include: { attachments: true } }),
    prisma.user.findMany(),
    passwordResetRequestModel.findMany({ include: { reviewedBy: true } }),
    prisma.personnelReport.findMany({ include: { reporter: true, target: true, resolvedBy: true } }),
    prisma.contentMetric.findMany(),
    prisma.contentViewEvent.findMany(),
    prisma.siteVisitEvent.findMany(),
    prisma.contentReaction.findMany(),
    prisma.mapMarker.findMany(),
    prisma.mapImage.findUnique({ where: { id: 'main' } }),
    prisma.botManagerCredential.findMany(),
    prisma.botManagerOpenRouterProfile.findMany(),
    prisma.botManagerProviderAnalyticsCredential.findMany(),
    prisma.botManagerProviderUsageEvent.findMany(),
    prisma.botManagerBackupJob.findMany({ where: activeArtifactWhere() }),
    prisma.botManagerGeneralConfig.findMany(),
    prisma.botManagerIdentity.findMany(),
    findActiveBotManagerIdentityFiles(),
    prisma.loreItem.findMany(),
    prisma.entityDoc.findMany()
  ]);

  const docsByEntity = new Map<string, typeof docs>();
  for (const doc of docs) {
    const key = `${doc.entityType}:${doc.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), doc]);
  }

  const loreByType = (category: EntityType) =>
    lore
      .filter((item) => item.category === category)
      .map((item) => serializeLoreItem(item, docsByEntity.get(`${item.category}:${item.id}`) ?? []));

  return {
    characters: loreByType(EntityType.character),
    creatures: loreByType(EntityType.creature),
    places: loreByType(EntityType.place),
    projects: projects.map(serializeProject),
    technology: loreByType(EntityType.technology),
    events: loreByType(EntityType.event),
    others: loreByType(EntityType.other),
    gallery: gallery.map((item) => serializeGalleryItem(item)),
    news: news.map(serializeNewsItem),
    personnel: personnel.map(serializeUser),
    passwordResetRequests: passwordResetRequests.map(serializePasswordResetRequestForExtraction),
    personnelReports: personnelReports.map(serializePersonnelReportForExtraction),
    contentMetrics,
    contentViewEvents,
    siteVisitEvents,
    contentReactions,
    map: {
      mapImage: mapImage?.imageUrl ?? '',
      markers: mapMarkers
    },
    botManager: {
      credentials: botManagerCredentials,
      openRouterProfiles: botManagerOpenRouterProfiles,
      analyticsCredentials: botManagerProviderAnalyticsCredentials,
      usageEvents: botManagerProviderUsageEvents,
      backupJobs: botManagerBackupJobs,
      generalConfig: botManagerGeneralConfig,
      identities: botManagerIdentities,
      files: botManagerFiles
    }
  };
};

export const normalizeMigrationDataset = (dataset: Partial<MigrationDataset>): MigrationDataset =>
  Object.fromEntries(
    MIGRATION_TABLES.map((table) => [table.key, Array.isArray(dataset[table.key]) ? dataset[table.key] : []])
  ) as MigrationDataset;

export const summarizeMigrationDataset = (dataset: MigrationDataset, assetCount: number) => ({
  tables: Object.fromEntries(
    MIGRATION_TABLES.map((table) => [table.key, Array.isArray(dataset[table.key]) ? dataset[table.key].length : 0])
  ),
  assetCount
});

export const collectMigrationDataset = async (): Promise<MigrationDataset> => {
  const entries = await Promise.all(
    MIGRATION_TABLES.map(async (table) => [table.key, await table.findMany()] as const)
  );
  return Object.fromEntries(entries) as MigrationDataset;
};

export const collectMigrationPayload = async (assetEndpoint: string): Promise<MigrationPayload> => {
  const dataset = await collectMigrationDataset();
  const assets = Array.from(await collectReferencedStoragePaths())
    .sort((left, right) => left.localeCompare(right))
    .map((objectPath) => ({ objectPath }));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { assetEndpoint },
    dataset,
    assets,
    summary: summarizeMigrationDataset(dataset, assets.length)
  };
};

export const countCurrentMigrationState = async () => {
  const tableCounts = await Promise.all(
    MIGRATION_TABLES.map(async (table) => [table.key, await table.count()] as const)
  );
  const assets = await collectReferencedStoragePaths();
  return {
    tables: Object.fromEntries(tableCounts),
    assetCount: assets.size
  };
};

export const importMigrationDataset = async (rawDataset: Partial<MigrationDataset>) => {
  const dataset = normalizeMigrationDataset(rawDataset);
  await prisma.$transaction(async (tx) => {
    for (const table of [...MIGRATION_TABLES].reverse()) {
      await table.deleteMany(tx);
    }

    for (const table of MIGRATION_TABLES) {
      const rows = dataset[table.key] as any[];
      if (rows.length) await table.createMany(tx, rows);
    }
  });
};

const jsonColumns = new Set([
  'metadata',
  'docs',
  'meta',
  'itemLimits',
  'manualSelections',
  'payload',
  'members',
  'monthly',
  'yearly',
  'supervised',
  'source',
  'attachments',
  'replyTo',
  'progress',
  'config'
]);

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const sqlValue = (column: string, value: unknown) => {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return sqlString(value.toISOString());
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' || jsonColumns.has(column)) return `${sqlString(JSON.stringify(value))}::jsonb`;
  return sqlString(String(value));
};

const sqlInsertBlock = (table: string, rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return `-- ${table}: no rows`;
  const columns = Object.keys(rows[0]);
  const columnSql = columns.map(sqlIdent).join(', ');
  const values = rows
    .map((row) => `(${columns.map((column) => sqlValue(column, row[column])).join(', ')})`)
    .join(',\n');
  return `INSERT INTO ${sqlIdent(table)} (${columnSql}) VALUES\n${values};`;
};

export const buildDatabaseSqlDump = (dataset: MigrationDataset) => {
  return [
    '-- Morneven full database backup',
    `-- Generated at ${new Date().toISOString()}`,
    '-- Apply migrations before restoring this file.',
    'BEGIN;',
    `TRUNCATE TABLE ${MIGRATION_TABLES.map((table) => sqlIdent(table.sqlTable)).join(', ')} RESTART IDENTITY CASCADE;`,
    ...MIGRATION_TABLES.map((table) =>
      sqlInsertBlock(table.sqlTable, dataset[table.key] as Array<Record<string, unknown>>)
    ),
    'COMMIT;',
    ''
  ].join('\n\n');
};
