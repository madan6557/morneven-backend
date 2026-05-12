import { AccountStatus, Role, Track } from '@prisma/client';

export type AuthUser = {
  id: string;
  username: string;
  role: Role;
  accountStatus: AccountStatus;
  level: number;
  track: Track;
  sessionId?: string;
};
