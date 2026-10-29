import { config } from '../config.js';
import { S3Storage } from './S3Storage.js';
import type { Storage } from './Storage.js';
import { SupabaseStorage } from './SupabaseStorage.js';

export type { Storage } from './Storage.js';

/** Build the configured Storage and verify its bucket exists. */
export async function createStorage(): Promise<Storage> {
  if (config.storage.driver === 's3') {
    const s3cfg = config.storage.s3;
    if (!s3cfg.endpoint || !s3cfg.accessKeyId || !s3cfg.secretAccessKey) {
      throw new Error('STORAGE_DRIVER=s3 but S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing');
    }
    const storage = new S3Storage({ ...s3cfg, bucket: config.storage.bucket });
    await storage.ensureBucket();
    return storage;
  }

  const storage = new SupabaseStorage(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    config.storage.bucket,
  );
  await storage.ensureBucket(false); // private — card images contain PII
  return storage;
}
