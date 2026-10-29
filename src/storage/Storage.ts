/**
 * Storage — the object-storage port for uploaded media (business-card images).
 *
 * v1 is implemented by SupabaseStorage (Supabase Storage, S3-compatible). A real
 * AWS S3 / R2 implementation can satisfy the same interface without touching the
 * flow. The rest of the app stores the returned `key` in entity_media.storage_url
 * and asks for a signed URL only when it needs to read the bytes back.
 */

export interface UploadParams {
  /** Object path within the bucket, e.g. "cards/<userId>/<uuid>.jpg". */
  key: string;
  data: Buffer;
  contentType: string;
  /** Overwrite if the key already exists (default false). */
  upsert?: boolean;
}

export interface Storage {
  /** Store bytes and return the object key (path) that was written. */
  upload(params: UploadParams): Promise<string>;

  /** Time-limited URL to read a private object. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /** Stable public URL — only meaningful if the bucket is public. */
  getPublicUrl(key: string): string;

  /** Delete an object. */
  remove(key: string): Promise<void>;
}
