import { Storage } from '@google-cloud/storage';
import { env } from './env.js';

const storage = new Storage({
  projectId: env.gcsProjectId || undefined
});

export const getStorageBucket = () => {
  if (!env.gcsBucketName) {
    throw new Error('GCS_BUCKET_NAME is not configured');
  }
  return storage.bucket(env.gcsBucketName);
};

export const buildObjectUrl = (objectPath: string) => {
  if (env.gcsPublicBaseUrl) {
    return `${env.gcsPublicBaseUrl.replace(/\/$/, '')}/${objectPath}`;
  }
  return `https://storage.googleapis.com/${env.gcsBucketName}/${objectPath}`;
};
