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
  // Voice transcription (Deepgram). Leave the key blank to disable voice: the
  // flow then asks users to type instead of sending audio.
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY ?? '',
    model: process.env.DEEPGRAM_MODEL ?? 'nova-2',
    language: process.env.DEEPGRAM_LANGUAGE ?? 'pt',
  },
  // Which messaging backend(s) drive the flow. Comma-separated to run more than
  // one at once, e.g. TRANSPORT_DRIVER=waha,telegram — WhatsApp and Telegram are
  // then served simultaneously and each user is answered on their own channel.
  transport: {
    drivers: (process.env.TRANSPORT_DRIVER ?? 'waha')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter((d): d is 'waha' | 'telegram' => d === 'waha' || d === 'telegram'),
  },
  waha: {
    baseUrl: process.env.WAHA_BASE_URL ?? 'http://localhost:3000',
    apiKey: process.env.WAHA_API_KEY ?? '',
    session: process.env.WAHA_SESSION ?? 'default',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    pollTimeout: Number(process.env.TELEGRAM_POLL_TIMEOUT ?? '30'),
    // If set, the transport registers this URL via setWebhook on start and
    // receives updates at POST /webhook/telegram instead of long polling.
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL ?? '',
    // Optional shared secret; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token.
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  },
  server: {
    port: Number(process.env.PORT ?? '8080'),
    webhookSecret: process.env.WEBHOOK_SECRET ?? '',
  },
} as const;
