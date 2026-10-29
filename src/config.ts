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
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    model: process.env.EMBEDDING_MODEL ?? 'google/gemini-embedding-2',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? '1536'),
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
