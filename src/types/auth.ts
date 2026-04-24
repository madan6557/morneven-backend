import { Role, Track } from '@prisma/client';

export type AuthUser = {
  id: string;
  username: string;
  role: Role;
  level: number;
  track: Track;
};
