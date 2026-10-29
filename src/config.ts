import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  storage: {
    // 's3' (S3-compatible endpoint, incl. Supabase S3 protocol) or 'supabase' (native API).
    driver: (process.env.STORAGE_DRIVER ?? 'supabase') as 's3' | 'supabase',
    bucket: process.env.STORAGE_BUCKET ?? 'business-cards',
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? '',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
  },
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    model: process.env.EMBEDDING_MODEL ?? 'google/gemini-embedding-2',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? '1536'),
  },
  agent: {
    // Must be vision + tool-calling capable on OpenRouter.
    model: process.env.AGENT_MODEL ?? 'google/gemini-2.5-flash',
    searchModel: process.env.AGENT_SEARCH_MODEL ?? 'google/gemini-2.5-flash',
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? '6'),
    webMaxResults: Number(process.env.AGENT_WEB_MAX_RESULTS ?? '5'),
  },
  worker: {
    enabled: (process.env.WORKER_ENABLED ?? 'true') === 'true',
    pollMs: Number(process.env.WORKER_POLL_MS ?? '3000'),
  },
  waha: {
    baseUrl: process.env.WAHA_BASE_URL ?? 'http://localhost:3000',
    apiKey: process.env.WAHA_API_KEY ?? '',
    session: process.env.WAHA_SESSION ?? 'default',
  },
  server: {
    port: Number(process.env.PORT ?? '8080'),
    webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  },
} as const;
