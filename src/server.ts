/**
 * Webhook server: receives WAHA events and drives the WhatsApp flow.
 *
 * Point WAHA's webhook at  POST http://<host>:<PORT>/webhook/waha
 * (set WHATSAPP_HOOK_URL / webhook config on the WAHA side).
 */

import express from 'express';

import { EnrichmentAgent } from './agent/EnrichmentAgent.js';
import { OpenRouterChat } from './agent/OpenRouterChat.js';
import { config } from './config.js';
import { log, logErr } from './log.js';
import { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import { WhatsAppFlow } from './flow.js';
import { SupabaseRepository } from './repository/SupabaseRepository.js';
import { createStorage } from './storage/index.js';
import { WahaTransport } from './transport/WahaTransport.js';
import { Worker } from './worker.js';

async function main() {
  await preflightSupabase();

  const transport = new WahaTransport(config.waha);
  const repo = new SupabaseRepository(config.supabase.url, config.supabase.serviceRoleKey);
  const embeddings = new EmbeddingClient(config.openrouter);
  const storage = await createStorage();
  const flow = new WhatsAppFlow(transport, repo, embeddings, storage);

  transport.onMessage(flow.handle);
  await transport.start();

  // Autonomous enrichment worker (agentic loop over OpenRouter).
  if (config.worker.enabled) {
    const chat = new OpenRouterChat(config.openrouter.apiKey);
    const agent = new EnrichmentAgent(chat, repo, embeddings, config.agent);
    const worker = new Worker(repo, agent, flow, storage, config.worker.pollMs);
    worker.start();
  }

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/webhook/waha', async (req, res) => {
    const event = (req.body as { event?: string })?.event;
    const msgId = (req.body as { payload?: { id?: string } })?.payload?.id;
    log('webhook', `received event=${event ?? '?'} id=${msgId ?? '-'}`);

    // Optional shared-secret check (configure the same value on WAHA).
    if (config.server.webhookSecret) {
      const got = req.header('x-api-key');
      if (got !== config.server.webhookSecret) {
        logErr('webhook', 'rejected: bad x-api-key');
        return res.sendStatus(401);
      }
    }
    // Ack immediately; process asynchronously so WAHA doesn't retry on slow work.
    res.sendStatus(200);
    try {
      await transport.handleWebhook(req.body);
    } catch (err) {
      logErr('webhook', 'handling failed', err);
    }
  });

  app.listen(config.server.port, () => {
    console.log(`bykonz webhook server listening on :${config.server.port}`);
  });
}

/** Fail fast with a clear message if Supabase isn't reachable / misconfigured. */
async function preflightSupabase(): Promise<void> {
  const url = config.supabase.url;
  const key = config.supabase.serviceRoleKey;
  console.log(`supabase url = ${url || '(empty!)'}  key = ${key ? `set (${key.length} chars)` : '(empty!)'}`);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
    console.warn('⚠️  SUPABASE_URL does not look like https://<ref>.supabase.co');
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log(`supabase preflight: HTTP ${res.status}`);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    console.error(
      `❌ cannot reach Supabase REST API: ${(err as Error).message}` +
        (cause ? ` (cause: ${cause.code ?? ''} ${cause.message ?? ''})` : ''),
    );
    console.error('   Check SUPABASE_URL is set correctly in your host env (Render dashboard).');
    throw err;
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
