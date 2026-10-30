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
import { TELEGRAM_WEBHOOK_PATH, TelegramTransport } from './transport/TelegramTransport.js';
import { TransportRouter } from './transport/TransportRouter.js';
import { WahaTransport } from './transport/WahaTransport.js';
import { DeepgramClient } from './voice/DeepgramClient.js';
import { Worker } from './worker.js';

async function main() {
  await preflightSupabase();

  const drivers = config.transport.drivers.length ? config.transport.drivers : ['waha'];
  log('server', `transport drivers = ${drivers.join(', ')}`);

  // Build every configured transport into one router so WhatsApp and Telegram
  // can run at the same time, each user answered on their own channel.
  const transports = new TransportRouter();
  let wahaTransport: WahaTransport | null = null;
  let telegramTransport: TelegramTransport | null = null;
  for (const driver of drivers) {
    if (driver === 'telegram') {
      telegramTransport = new TelegramTransport(config.telegram);
      transports.register(telegramTransport);
    } else {
      wahaTransport = new WahaTransport(config.waha);
      transports.register(wahaTransport);
    }
  }

  const repo = new SupabaseRepository(config.supabase.url, config.supabase.serviceRoleKey);
  const embeddings = new EmbeddingClient(config.openrouter);
  const storage = await createStorage();
  // Shared OpenRouter chat client: Consultar reranking + the enrichment agent.
  const chat = new OpenRouterChat(config.openrouter.apiKey);
  // Voice is optional: only enabled when a Deepgram key is configured.
  const voice = config.deepgram.apiKey
    ? new DeepgramClient({
        apiKey: config.deepgram.apiKey,
        model: config.deepgram.model,
        language: config.deepgram.language,
      })
    : undefined;
  log('server', `voice transcription ${voice ? 'enabled (Deepgram)' : 'disabled (no DEEPGRAM_API_KEY)'}`);
  const flow = new WhatsAppFlow(transports, repo, embeddings, storage, chat, config.agent.model, voice);

  for (const transport of transports.all()) {
    transport.onMessage(flow.handle);
    await transport.start();
  }

  // Autonomous enrichment worker (agentic loop over OpenRouter).
  if (config.worker.enabled) {
    const agent = new EnrichmentAgent(chat, repo, embeddings, config.agent);
    const worker = new Worker(repo, agent, flow, storage, embeddings, config.worker.pollMs);
    worker.start();
  }

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // WAHA is webhook-driven; Telegram uses its own long-polling loop (no route).
  if (wahaTransport) {
    const waha = wahaTransport;

    // Reachability test: open this in a browser to confirm the server is public.
    app.get('/webhook/waha', (_req, res) => {
      log('webhook', 'GET /webhook/waha (reachability check)');
      res.json({ ok: true, hint: 'POST WAHA message events here' });
    });

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
        await waha.handleWebhook(req.body);
      } catch (err) {
        logErr('webhook', 'handling failed', err);
      }
    });
  }

  // Telegram webhook mode: set TELEGRAM_WEBHOOK_URL=https://<host>/webhook/telegram
  // (the transport registers it via setWebhook on start). Without that env var the
  // Telegram transport long-polls instead and this route is simply unused.
  if (telegramTransport) {
    const tg = telegramTransport;

    app.get(TELEGRAM_WEBHOOK_PATH, (_req, res) => {
      log('webhook', `GET ${TELEGRAM_WEBHOOK_PATH} (reachability check)`);
      res.json({ ok: true, hint: 'POST Telegram updates here' });
    });

    app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
      // Verify the secret Telegram echoes back, if one is configured.
      if (tg.webhookSecret) {
        const got = req.header('x-telegram-bot-api-secret-token');
        if (got !== tg.webhookSecret) {
          logErr('webhook', 'telegram: rejected bad secret token');
          return res.sendStatus(401);
        }
      }
      // Ack immediately; process async so Telegram doesn't retry on slow work.
      res.sendStatus(200);
      try {
        await tg.handleWebhook(req.body);
      } catch (err) {
        logErr('webhook', 'telegram handling failed', err);
      }
    });
  }

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
