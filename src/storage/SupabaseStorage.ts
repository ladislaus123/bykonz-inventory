/**
 * SupabaseStorage — v1 Storage backed by Supabase Storage (S3-compatible).
 * Uses the service-role key so uploads bypass Storage RLS policies server-side.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Storage, UploadParams } from './Storage.js';

export class SupabaseStorage implements Storage {
  private readonly db: SupabaseClient;
  private readonly bucket: string;

  constructor(url: string, serviceRoleKey: string, bucket: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.bucket = bucket;
  }

  /** Create the bucket if it doesn't exist (call once at startup). */
  async ensureBucket(isPublic = false): Promise<void> {
    const { data, error } = await this.db.storage.getBucket(this.bucket);
    if (data) return;
    // getBucket errors when the bucket is missing; create it.
    if (error) {
      const { error: createErr } = await this.db.storage.createBucket(this.bucket, {
        public: isPublic,
      });
      // Ignore "already exists" races.
      if (createErr && !/exist/i.test(createErr.message)) throw createErr;
    }
  }

  async upload(params: UploadParams): Promise<string> {
    const { error } = await this.db.storage.from(this.bucket).upload(params.key, params.data, {
      contentType: params.contentType,
      upsert: params.upsert ?? false,
    });
    if (error) throw new Error(`[SupabaseStorage.upload] ${error.message}`);
    return params.key;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const { data, error } = await this.db.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) throw new Error(`[SupabaseStorage.getSignedUrl] ${error?.message}`);
    return data.signedUrl;
  }

  getPublicUrl(key: string): string {
    return this.db.storage.from(this.bucket).getPublicUrl(key).data.publicUrl;
  }

  async remove(key: string): Promise<void> {
    const { error } = await this.db.storage.from(this.bucket).remove([key]);
    if (error) throw new Error(`[SupabaseStorage.remove] ${error.message}`);
  }
}
