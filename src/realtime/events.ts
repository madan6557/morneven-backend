import { AuthUser } from '../types/auth.js';
import { getNavigationBadges } from '../modules/me/badges.js';

export type RealtimePayload = Record<string, unknown>;

export type RealtimeEventMeta = {
  eventId: string;
  sequence: number;
  emittedAt: string;
};

type RealtimeClient = {
  user: AuthUser;
  send: (event: string, payload: RealtimePayload, meta?: RealtimeEventMeta) => void;
  close?: () => void;
};

const clientsByUsername = new Map<string, Set<RealtimeClient>>();
const eventHistoryByUsername = new Map<string, Array<{ event: string; payload: RealtimePayload; meta: RealtimeEventMeta }>>();
let realtimeSequence = 0;
const MAX_EVENT_HISTORY = 256;

const createEventMeta = (): RealtimeEventMeta => ({
  eventId: crypto.randomUUID(),
  sequence: ++realtimeSequence,
  emittedAt: new Date().toISOString()
});

const rememberEvent = (username: string, event: string, payload: RealtimePayload, meta: RealtimeEventMeta) => {
  const history = eventHistoryByUsername.get(username) ?? [];
  history.push({ event, payload, meta });
  if (history.length > MAX_EVENT_HISTORY) history.splice(0, history.length - MAX_EVENT_HISTORY);
  eventHistoryByUsername.set(username, history);
};

export const replayRealtimeEvents = (
  username: string,
  afterSequence: number,
  send: (event: string, payload: RealtimePayload, meta?: RealtimeEventMeta) => void
) => {
  const history = eventHistoryByUsername.get(username) ?? [];
  const events = history.filter((entry) => entry.meta.sequence > afterSequence);
  for (const entry of events) send(entry.event, entry.payload, entry.meta);
  return events.length;
};
type RealtimeSessionSelector = string | {
  username?: string;
  sessionId?: string;
};

export const registerRealtimeClient = (client: RealtimeClient) => {
  const clients = clientsByUsername.get(client.user.username) ?? new Set<RealtimeClient>();
  clients.add(client);
  clientsByUsername.set(client.user.username, clients);

  return () => {
    clients.delete(client);
    if (clients.size === 0) clientsByUsername.delete(client.user.username);
  };
};

export const emitToUser = (username: string, event: string, payload: RealtimePayload) => {
  const meta = createEventMeta();
  rememberEvent(username, event, payload, meta);
  for (const client of clientsByUsername.get(username) ?? []) {
    client.send(event, payload, meta);
  }
};

export const emitToUsers = (usernames: Iterable<string>, event: string, payload: RealtimePayload) => {
  for (const username of usernames) emitToUser(username, event, payload);
};

export const invalidateRealtimeSessions = (selector: RealtimeSessionSelector, payload: RealtimePayload) => {
  const username = typeof selector === 'string' ? selector : selector.username;
  const sessionId = typeof selector === 'string' ? undefined : selector.sessionId;
  const clientSets = username ? [clientsByUsername.get(username)] : [...clientsByUsername.values()];

  for (const clients of clientSets) {
    for (const client of [...(clients ?? [])]) {
      if (sessionId && client.user.sessionId !== sessionId) continue;
      client.send('auth.session.invalidated', payload);
      client.close?.();
    }
  }
};

export const emitToMatchingClients = (
  predicate: (user: AuthUser) => boolean,
  event: string,
  payload: RealtimePayload
) => {
  for (const clients of clientsByUsername.values()) {
    for (const client of clients) {
      if (predicate(client.user)) {
        const meta = createEventMeta();
        rememberEvent(client.user.username, event, payload, meta);
        client.send(event, payload, meta);
      }
    }
  }
};

export const emitNavigationBadgesUpdated = async (user: AuthUser | string) => {
  const username = typeof user === 'string' ? user : user.username;
  const clients = clientsByUsername.get(username);
  if (!clients?.size) return;
  const authUser = typeof user === 'string' ? [...clients][0].user : user;
  emitToUser(username, 'navigation_badges.updated', await getNavigationBadges(authUser));
};

export const emitNavigationBadgesUpdatedForUsers = async (usernames: Iterable<string>) => {
  await Promise.all([...new Set(usernames)].map((username) => emitNavigationBadgesUpdated(username)));
};
