type PresenceEntry = {
  sessions: number;
  lastSeenAt: number;
};

const ACTIVE_WINDOW_MS = 75 * 1000;
const presenceByUsername = new Map<string, PresenceEntry>();

const now = () => Date.now();

const pruneExpired = () => {
  const cutoff = now() - ACTIVE_WINDOW_MS;
  for (const [username, entry] of presenceByUsername.entries()) {
    if (entry.lastSeenAt < cutoff || entry.sessions <= 0) {
      presenceByUsername.delete(username);
    }
  }
};

export const markPresenceOnline = (username: string) => {
  const current = presenceByUsername.get(username);
  if (!current) {
    presenceByUsername.set(username, { sessions: 1, lastSeenAt: now() });
    return;
  }
  current.sessions += 1;
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
};

export const heartbeatPresence = (username: string) => {
  const current = presenceByUsername.get(username);
  if (!current) {
    presenceByUsername.set(username, { sessions: 1, lastSeenAt: now() });
    return;
  }
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
};

export const markPresenceOffline = (username: string) => {
  const current = presenceByUsername.get(username);
  if (!current) return;
  current.sessions -= 1;
  if (current.sessions <= 0) {
    presenceByUsername.delete(username);
    return;
  }
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
};

export const getPresenceSnapshot = (username: string) => {
  pruneExpired();
  const entry = presenceByUsername.get(username);
  const online = Boolean(entry && entry.lastSeenAt >= now() - ACTIVE_WINDOW_MS && entry.sessions > 0);
  return {
    online,
    lastSeenAt: entry ? new Date(entry.lastSeenAt).toISOString() : undefined
  };
};
