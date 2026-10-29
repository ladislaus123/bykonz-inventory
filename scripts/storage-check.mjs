// Standalone S3 connectivity check — reads only the S3_* env vars (not config.ts,
// so missing Supabase/OpenRouter keys don't block it). Uploads a 1x1 PNG, reads
// it back via a signed URL, then deletes it.
import 'dotenv/config';
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STORAGE_BUCKET } =
  process.env;

const bucket = STORAGE_BUCKET ?? 'business-cards';
console.log(`endpoint=${S3_ENDPOINT}\nregion=${S3_REGION}\nbucket=${bucket}\n`);

const client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

// 1x1 transparent PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const key = `cards/_healthcheck/${Date.now()}.png`;

async function step(name, fn) {
  try {
    const out = await fn();
    console.log(`✅ ${name}${out ? `: ${out}` : ''}`);
    return true;
  } catch (err) {
    console.log(`❌ ${name}: ${err.name} — ${err.message}`);
    if (err.$metadata) console.log(`   http=${err.$metadata.httpStatusCode}`);
    return false;
  }
}

const headOk = await step('HeadBucket (bucket exists + creds valid)', () =>
  client.send(new HeadBucketCommand({ Bucket: bucket })),
);
if (!headOk) {
  console.log('\n→ If this failed with 404/NoSuchBucket: create the bucket (private) in');
  console.log('  Supabase Dashboard → Storage. If 403: the access key is wrong/rotated.');
  process.exit(1);
}

await step('PutObject', () =>
  client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: png, ContentType: 'image/png' })),
);

const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
  expiresIn: 300,
});
await step('GetObject via signed URL', async () => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return `${bytes.length} bytes, matches=${bytes.equals(png)}`;
});

await step('DeleteObject (cleanup)', () =>
  client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
);

console.log('\nDone.');
