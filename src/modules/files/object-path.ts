const allowedObjectFolders = new Set([
  'gallery',
  'lore',
  'projects',
  'news',
  'map',
  'chat',
  'bot-manager',
  'exports',
  'uploads'
]);

export const normalizeObjectPath = (value: string) => value.trim().replace(/^\/+/, '');

export const isSafeObjectPath = (value: string) => {
  if (!value || value.length > 2048) return false;
  if (value.includes('\\')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return true;
};

export const isAllowedObjectPath = (value: string) => {
  const rootFolder = value.split('/')[0];
  return allowedObjectFolders.has(rootFolder);
};

export const isReadableObjectPath = (value: string) => {
  const normalized = normalizeObjectPath(value);
  return isSafeObjectPath(normalized) && isAllowedObjectPath(normalized);
};

export const buildObjectProxyUrl = (objectPath: string, apiBasePath = '/api/files/object') =>
  `${apiBasePath}?path=${encodeURIComponent(normalizeObjectPath(objectPath))}`;
