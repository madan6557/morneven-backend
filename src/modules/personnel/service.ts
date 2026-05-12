import { AccountStatus, Prisma, Role, Track } from '@prisma/client';
import { ensureInstituteMembership, reconcileAutoMemberships, revokeConversationAccessForUser, syncDivisionMembership } from '../chat/service.js';
import { invalidateRealtimeSessions } from '../../realtime/events.js';
import { roleForLevel } from '../../utils/serializers.js';

// Confirmed-report policy:
// 2 confirmed reports: one automatic demotion.
// 4 confirmed reports: automatic ban and session revocation.
export const REPORT_AUTO_DEMOTE_THRESHOLD = 2;
export const REPORT_AUTO_BAN_THRESHOLD = 4;

export const PERSONNEL_REPORT_CATEGORIES = [
  'misconduct',
  'harassment',
  'abuse',
  'spam',
  'security',
  'other'
] as const;

export const PERSONNEL_REPORT_STATUSES = ['open', 'confirmed', 'dismissed'] as const;

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

type UserLike = {
  id: string;
  username: string;
  role: Role;
  accountStatus: AccountStatus;
  level: number;
  track: Track;
  disciplineStrikeCount: number;
  disciplineTier: number;
};

export const isAccountActive = (status: AccountStatus) => status === AccountStatus.active;

export const canModerateAccount = (
  actor: { id: string; level: number; role: Role },
  target: { id: string; level: number; role: Role }
) => {
  if (actor.id === target.id) return false;
  if (actor.level < 6) return false;
  if (target.role === Role.author) return false;
  if (actor.level === 6) return target.level < 6;
  if (actor.level >= 7 && actor.role === Role.author) return true;
  return target.level < 7;
};

const syncMembershipsForUser = async (db: DbClient, user: Pick<UserLike, 'username' | 'level' | 'track' | 'accountStatus'>) => {
  const effectiveLevel = isAccountActive(user.accountStatus) ? user.level : 0;
  await ensureInstituteMembership(user.username, effectiveLevel, db as any, { emit: true });
  await syncDivisionMembership(user.username, user.track, effectiveLevel, db as any, { emit: true });
};

const applyInactiveAccountSideEffects = async (
  db: DbClient,
  user: Pick<UserLike, 'username'>,
  nextStatus: AccountStatus
) => {
  await revokeConversationAccessForUser(user.username, db as any, { emit: true });
  await reconcileAutoMemberships(db as any, { emit: true });
  invalidateRealtimeSessions(user.username, {
    reason: 'account_status_changed',
    status: nextStatus
  });
};

export const updateAccountStatus = async (
  db: DbClient,
  user: UserLike,
  nextStatus: AccountStatus,
  reason?: string | null
) => {
  const statusChanged = user.accountStatus !== nextStatus;
  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      accountStatus: nextStatus,
      statusReason: reason ?? null,
      statusChangedAt: new Date(),
      ...(nextStatus === AccountStatus.deleted
        ? { level: 0, role: Role.guest, track: Track.executive }
        : {})
    }
  });

  if (nextStatus !== AccountStatus.active) {
    await db.refreshToken.deleteMany({ where: { userId: user.id } });
  }

  await syncMembershipsForUser(db, {
    username: updated.username,
    level: updated.level,
    track: updated.track,
    accountStatus: updated.accountStatus
  });

  if (statusChanged) {
    if (nextStatus === AccountStatus.active) {
      await reconcileAutoMemberships(db as any, { emit: true });
    } else {
      await applyInactiveAccountSideEffects(db, updated, nextStatus);
    }
  }

  return updated;
};

export const applyConfirmedReportDiscipline = async (
  db: DbClient,
  target: UserLike,
  reason: string
) => {
  let nextStrikeCount = target.disciplineStrikeCount + 1;
  let nextTier = target.disciplineTier;
  let nextLevel = target.level;
  let nextRole = target.role;
  let nextStatus = target.accountStatus;
  let action = 'none';

  if (nextStrikeCount >= REPORT_AUTO_BAN_THRESHOLD && nextTier < 2) {
    nextTier = 2;
    nextStatus = AccountStatus.banned;
    action = 'auto-ban';
  } else if (nextStrikeCount >= REPORT_AUTO_DEMOTE_THRESHOLD && nextTier < 1) {
    nextTier = 1;
    nextLevel = Math.max(1, target.level - 1);
    nextRole = roleForLevel(nextLevel);
    action = 'auto-demote';
  }

  const updated = await db.user.update({
    where: { id: target.id },
    data: {
      disciplineStrikeCount: nextStrikeCount,
      disciplineTier: nextTier,
      level: nextLevel,
      role: nextRole,
      accountStatus: nextStatus,
      ...(action !== 'none'
        ? {
            statusReason: reason,
            statusChangedAt: new Date()
          }
        : {})
    }
  });

  if (updated.accountStatus !== AccountStatus.active) {
    await db.refreshToken.deleteMany({ where: { userId: updated.id } });
    await applyInactiveAccountSideEffects(db, updated, updated.accountStatus);
  } else if (updated.level !== target.level || updated.track !== target.track) {
    await reconcileAutoMemberships(db as any, { emit: true });
  }

  await syncMembershipsForUser(db, {
    username: updated.username,
    level: updated.level,
    track: updated.track,
    accountStatus: updated.accountStatus
  });

  return { updated, action };
};
