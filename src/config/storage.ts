import { Storage } from '@google-cloud/storage';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { env } from './env.js';

const storage = new Storage({
  projectId: env.gcsProjectId || undefined
});

type SaveFileInput = {
  objectPath: string;
  buffer: Buffer;
  contentType: string;
};

type SaveFileResult = {
  objectPath: string;
  location: string;
  url: string;
};

const getStorageBucket = () => {
  if (!env.gcsBucketName) {
    throw new Error('GCS_BUCKET_NAME is not configured');
  }
  return storage.bucket(env.gcsBucketName);
};

const buildGcsUrl = (objectPath: string) => {
  if (env.gcsPublicBaseUrl) {
    return `${env.gcsPublicBaseUrl.replace(/\/$/, '')}/${objectPath}`;
  }
  return `https://storage.googleapis.com/${env.gcsBucketName}/${objectPath}`;
};

const buildLocalUrl = (objectPath: string) => {
  return `${env.localStorageBasePath.replace(/\/$/, '')}/${objectPath}`;
};

export const saveFileToStorage = async (input: SaveFileInput): Promise<SaveFileResult> => {
  if (env.storageDriver === 'local') {
    const fullPath = path.join(env.localStoragePath, input.objectPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.buffer);

    return {
      objectPath: input.objectPath,
      location: env.localStoragePath,
      url: buildLocalUrl(input.objectPath)
    };
  }

  const bucket = getStorageBucket();
  const file = bucket.file(input.objectPath);
  await file.save(input.buffer, {
    metadata: { contentType: input.contentType },
    resumable: false,
    validation: 'crc32c'
  });

  return {
    objectPath: input.objectPath,
    location: bucket.name,
    url: buildGcsUrl(input.objectPath)
  };
};
