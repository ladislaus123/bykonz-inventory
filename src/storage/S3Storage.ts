/**
 * S3Storage — Storage backed by any S3-compatible endpoint (AWS S3, Cloudflare
 * R2, or Supabase Storage's S3 protocol at <ref>.storage.supabase.co/storage/v1/s3).
 *
 * Supabase note: buckets are NOT created over the S3 protocol — create the bucket
 * (private) in the Supabase dashboard first. ensureBucket() only verifies it exists.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Storage, UploadParams } from './Storage.js';

export interface S3Config {
  endpoint: string; // https://<ref>.storage.supabase.co/storage/v1/s3
  region: string; // us-west-2
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: true, // required for Supabase / most S3-compatible gateways
    });
  }

  /** Verify the bucket exists (Supabase S3 can't create buckets; use the dashboard). */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
    } catch (err) {
      throw new Error(
        `S3 bucket "${this.cfg.bucket}" not reachable. On Supabase, create it ` +
          `(private) in Dashboard → Storage first. Cause: ${(err as Error).message}`,
      );
    }
  }

  async upload(params: UploadParams): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: params.key,
        Body: params.data,
        ContentType: params.contentType,
      }),
    );
    return params.key;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  getPublicUrl(key: string): string {
    // Path-style public URL; only resolvable if the bucket/object is public.
    return `${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${key}`;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
