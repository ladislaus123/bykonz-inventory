/**
 * Webhook server: receives WAHA events and drives the WhatsApp flow.
 *
 * Point WAHA's webhook at  POST http://<host>:<PORT>/webhook/waha
 * (set WHATSAPP_HOOK_URL / webhook config on the WAHA side).
 */

import express from 'express';

import { config } from './config.js';
import { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import { WhatsAppFlow } from './flow.js';
import { SupabaseRepository } from './repository/SupabaseRepository.js';
import { WahaTransport } from './transport/WahaTransport.js';

async function main() {
  const transport = new WahaTransport(config.waha);
  const repo = new SupabaseRepository(config.supabase.url, config.supabase.serviceRoleKey);
  const embeddings = new EmbeddingClient(config.openrouter);
  const flow = new WhatsAppFlow(transport, repo, embeddings);

  transport.onMessage(flow.handle);
  await transport.start();

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/webhook/waha', async (req, res) => {
    // Optional shared-secret check (configure the same value on WAHA).
    if (config.server.webhookSecret) {
      const got = req.header('x-api-key');
      if (got !== config.server.webhookSecret) return res.sendStatus(401);
    }
    // Ack immediately; process asynchronously so WAHA doesn't retry on slow work.
    res.sendStatus(200);
    try {
      await transport.handleWebhook(req.body);
    } catch (err) {
      console.error('webhook handling failed:', err);
    }
  });

  app.listen(config.server.port, () => {
    console.log(`bykonz webhook server listening on :${config.server.port}`);
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
