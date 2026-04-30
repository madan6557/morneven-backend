import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { env } from './env.js';

let storageClient: Storage | null = null;
let s3Client: S3Client | null = null;

const getStorageClient = () => {
  if (!storageClient) {
    storageClient = new Storage({ projectId: env.gcsProjectId || undefined });
  }
  return storageClient;
};

const getS3Client = () => {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.s3Region ?? 'auto',
      endpoint: env.s3Endpoint,
      forcePathStyle: env.s3ForcePathStyle,
      credentials:
        env.s3AccessKeyId && env.s3SecretAccessKey
          ? { accessKeyId: env.s3AccessKeyId, secretAccessKey: env.s3SecretAccessKey }
          : undefined
    });
  }
  return s3Client;
};

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
    throw new Error('GCS_BUCKET_NAME is required when STORAGE_DRIVER=gcs');
  }
  return getStorageClient().bucket(env.gcsBucketName);
};

const getS3BucketName = () => {
  if (!env.s3BucketName) {
    throw new Error('S3_BUCKET_NAME is required when STORAGE_DRIVER=s3');
  }
  return env.s3BucketName;
};

const buildGcsUrl = (objectPath: string) => {
  if (env.gcsPublicBaseUrl) {
    return `${env.gcsPublicBaseUrl.replace(/\/$/, '')}/${objectPath}`;
  }
  return `https://storage.googleapis.com/${env.gcsBucketName}/${objectPath}`;
};

const buildS3Url = (objectPath: string, bucketName: string) => {
  if (env.s3PublicBaseUrl) {
    return `${env.s3PublicBaseUrl.replace(/\/$/, '')}/${objectPath}`;
  }

  if (env.s3Endpoint) {
    const endpoint = env.s3Endpoint.replace(/\/$/, '');
    return env.s3ForcePathStyle ? `${endpoint}/${bucketName}/${objectPath}` : `${endpoint}/${objectPath}`;
  }

  const region = env.s3Region ?? 'us-east-1';
  return `https://${bucketName}.s3.${region}.amazonaws.com/${objectPath}`;
};

const buildLocalUrl = (objectPath: string) => `${env.localStorageBasePath.replace(/\/$/, '')}/${objectPath}`;

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

  if (env.storageDriver === 's3') {
    const bucketName = getS3BucketName();
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: input.objectPath,
        Body: input.buffer,
        ContentType: input.contentType
      })
    );

    return {
      objectPath: input.objectPath,
      location: bucketName,
      url: buildS3Url(input.objectPath, bucketName)
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
