import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { S3Storage } from '../../src/storage/S3Storage.js';
import { SupabaseStorage } from '../../src/storage/SupabaseStorage.js';
import type { Storage } from '../../src/storage/Storage.js';
import { liveEnabled, requireEnv } from '../helpers/live.js';

describe('live object storage', { concurrency: 1, skip: liveEnabled() ? false : 'set RUN_LIVE_TESTS=1 (npm run test:live or npm run test:ci)' }, () => {
  test('uploads a private object, signs it, reads it back, and deletes it', { timeout: 60_000 }, async () => {
    const driver = (process.env.STORAGE_DRIVER ?? 'supabase').toLowerCase();
    const bucket = process.env.STORAGE_BUCKET ?? 'business-cards';
    const key = `ci-tests/${randomUUID()}.txt`;
    const body = Buffer.from(`ci-bykonz ${key}`);
    let storage: Storage;

    if (driver === 's3') {
      const s3 = new S3Storage({
        endpoint: requireEnv('S3_ENDPOINT'),
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
        bucket,
      });
      await s3.ensureBucket();
      storage = s3;
    } else if (driver === 'supabase') {
      const supabase = new SupabaseStorage(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), bucket);
      await supabase.ensureBucket(false);
      storage = supabase;
    } else {
      throw new Error(`Unknown STORAGE_DRIVER "${driver}"`);
    }

    try {
      const stored = await storage.upload({ key, data: body, contentType: 'text/plain' });
      assert.equal(stored, key);
      assert.ok(storage.getPublicUrl(key).includes(randomTail(key)));
      const signed = await storage.getSignedUrl(key, 60);
      const res = await fetch(signed);
      assert.equal(res.status, 200, `signed URL fetch failed: HTTP ${res.status}`);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), body.toString());
    } finally {
      await storage.remove(key).catch(() => undefined);
    }
  });
});

function randomTail(key: string): string {
  const name = key.split('/').at(-1) ?? key;
  return name.replace(/\.txt$/, '');
}
