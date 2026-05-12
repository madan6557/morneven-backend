type PresenceEntry = {
  sessions: number;
  lastSeenAt: number;
};

const ACTIVE_WINDOW_MS = 75 * 1000;
const presenceByUsername = new Map<string, PresenceEntry>();

const now = () => Date.now();

const snapshotFor = (entry?: PresenceEntry) => ({
  online: Boolean(entry && entry.lastSeenAt >= now() - ACTIVE_WINDOW_MS && entry.sessions > 0),
  lastSeenAt: entry ? new Date(entry.lastSeenAt).toISOString() : undefined
});

const pruneExpired = () => {
  const cutoff = now() - ACTIVE_WINDOW_MS;
  for (const [username, entry] of presenceByUsername.entries()) {
    if (entry.lastSeenAt < cutoff || entry.sessions <= 0) {
      presenceByUsername.delete(username);
    }
  }
};

export const markPresenceOnline = (username: string) => {
  pruneExpired();
  const current = presenceByUsername.get(username);
  if (!current) {
    const entry = { sessions: 1, lastSeenAt: now() };
    presenceByUsername.set(username, entry);
    return { changed: true, ...snapshotFor(entry) };
  }
  const wasOnline = current.lastSeenAt >= now() - ACTIVE_WINDOW_MS && current.sessions > 0;
  current.sessions += 1;
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
  return { changed: !wasOnline, ...snapshotFor(current) };
};

export const heartbeatPresence = (username: string) => {
  pruneExpired();
  const current = presenceByUsername.get(username);
  if (!current) {
    const entry = { sessions: 1, lastSeenAt: now() };
    presenceByUsername.set(username, entry);
    return { changed: true, ...snapshotFor(entry) };
  }
  const wasOnline = current.lastSeenAt >= now() - ACTIVE_WINDOW_MS && current.sessions > 0;
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
  return { changed: !wasOnline, ...snapshotFor(current) };
};

export const markPresenceOffline = (username: string) => {
  const current = presenceByUsername.get(username);
  if (!current) return { changed: false, online: false, lastSeenAt: undefined };
  current.sessions -= 1;
  if (current.sessions <= 0) {
    presenceByUsername.delete(username);
    return { changed: true, online: false, lastSeenAt: new Date().toISOString() };
  }
  current.lastSeenAt = now();
  presenceByUsername.set(username, current);
  return { changed: false, ...snapshotFor(current) };
};

export const getPresenceSnapshot = (username: string) => {
  pruneExpired();
  const entry = presenceByUsername.get(username);
  return snapshotFor(entry);
};
