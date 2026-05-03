import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { env } from './env.js';

let storageClient: Storage | null = null;
let s3Client: any = null;

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

export type ReadFileFromStorageResult = {
  buffer: Buffer;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
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
    return `${endpoint}/${bucketName}/${objectPath}`;
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

const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const readFileWithMetadataFromStorage = async (objectPath: string): Promise<ReadFileFromStorageResult> => {
  if (env.storageDriver === 'local') {
    const fullPath = path.join(env.localStoragePath, objectPath);
    const { readFile } = await import('fs/promises');
    const buffer = await readFile(fullPath);
    return {
      buffer,
      contentLength: buffer.byteLength
    };
  }

  if (env.storageDriver === 's3') {
    const bucketName = getS3BucketName();
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: objectPath
      })
    );
    if (!response.Body) throw new Error('S3 object body is empty');
    const buffer = await streamToBuffer(response.Body as Readable);
    return {
      buffer,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      etag: response.ETag,
      lastModified: response.LastModified
    };
  }

  const bucket = getStorageBucket();
  const file = bucket.file(objectPath);
  const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
  return {
    buffer,
    contentType: metadata.contentType,
    contentLength: metadata.size ? Number(metadata.size) : undefined,
    etag: metadata.etag,
    lastModified: metadata.updated ? new Date(metadata.updated) : undefined
  };
};

export const readFileFromStorage = async (objectPath: string): Promise<Buffer> => {
  const file = await readFileWithMetadataFromStorage(objectPath);
  return file.buffer;
};
