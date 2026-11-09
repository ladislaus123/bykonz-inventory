/**
 * HTTP surface of the webhook server (health + WAHA / Telegram routes).
 * Kept separate from server.ts so tests can boot the app without opening
 * transports, the worker, or the Supabase preflight.
 */

import express, { type Express } from 'express';

import { log, logErr } from './log.js';
import { TELEGRAM_WEBHOOK_PATH, type TelegramTransport } from './transport/TelegramTransport.js';
import type { WahaTransport } from './transport/WahaTransport.js';

export interface HttpAppDeps {
  waha: WahaTransport | null;
  telegram: TelegramTransport | null;
  /** Shared secret for POST /webhook/waha (header x-api-key). Empty disables the check. */
  webhookSecret: string;
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // WAHA is webhook-driven; Telegram uses its own long-polling loop unless a
  // webhook URL is configured, in which case updates arrive here too.
  if (deps.waha) {
    const waha = deps.waha;

    app.get('/webhook/waha', (_req, res) => {
      log('webhook', 'GET /webhook/waha (reachability check)');
      res.json({ ok: true, hint: 'POST WAHA message events here' });
    });

    app.post('/webhook/waha', async (req, res) => {
      const event = (req.body as { event?: string })?.event;
      const msgId = (req.body as { payload?: { id?: string } })?.payload?.id;
      log('webhook', `received event=${event ?? '?'} id=${msgId ?? '-'}`);

      if (deps.webhookSecret) {
        const got = req.header('x-api-key');
        if (got !== deps.webhookSecret) {
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

  if (deps.telegram) {
    const tg = deps.telegram;

    app.get(TELEGRAM_WEBHOOK_PATH, (_req, res) => {
      log('webhook', `GET ${TELEGRAM_WEBHOOK_PATH} (reachability check)`);
      res.json({ ok: true, hint: 'POST Telegram updates here' });
    });

    app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
      if (tg.webhookSecret) {
        const got = req.header('x-telegram-bot-api-secret-token');
        if (got !== tg.webhookSecret) {
          logErr('webhook', 'telegram: rejected bad secret token');
          return res.sendStatus(401);
        }
      }
      res.sendStatus(200);
      try {
        await tg.handleWebhook(req.body);
      } catch (err) {
        logErr('webhook', 'telegram handling failed', err);
      }
    });
  }

  return app;
}
