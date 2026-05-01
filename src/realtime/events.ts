import { AuthUser } from '../types/auth.js';
import { getNavigationBadges } from '../modules/me/badges.js';

export type RealtimePayload = Record<string, unknown>;

type RealtimeClient = {
  user: AuthUser;
  send: (event: string, payload: RealtimePayload) => void;
};

const clientsByUsername = new Map<string, Set<RealtimeClient>>();

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
  for (const client of clientsByUsername.get(username) ?? []) {
    client.send(event, payload);
  }
};

export const emitToUsers = (usernames: Iterable<string>, event: string, payload: RealtimePayload) => {
  for (const username of usernames) emitToUser(username, event, payload);
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
