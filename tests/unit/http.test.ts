import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createHttpApp } from '../../src/http.js';
import { TelegramTransport } from '../../src/transport/TelegramTransport.js';
import type { IncomingMessage } from '../../src/transport/MessageTransport.js';
import { WahaTransport } from '../../src/transport/WahaTransport.js';
import { request, withServer } from '../helpers/http-server.js';

class ThrowingWaha extends WahaTransport {
  override async handleWebhook(): Promise<void> {
    throw new Error('handler exploded');
  }
}

const wahaMessage = {
  event: 'message',
  payload: { id: 'm1', timestamp: 1, from: '5511@c.us', fromMe: false, body: 'oi', type: 'chat' },
};

describe('HTTP webhook surface', { concurrency: 1 }, () => {
  test('health and the WAHA reachability probe', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const app = createHttpApp({ waha, telegram: null, webhookSecret: '' });
    await withServer(app, async (base) => {
      const health = await request(base, 'GET', '/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { ok: true });
      const probe = await request(base, 'GET', '/webhook/waha');
      assert.equal(probe.status, 200);
      assert.equal((probe.body as { ok: boolean }).ok, true);
      const missing = await request(base, 'GET', '/webhook/telegram');
      assert.equal(missing.status, 404);
    });
  });

  test('rejects a WAHA post with the wrong shared secret and accepts the right one', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const seen: IncomingMessage[] = [];
    waha.onMessage((message) => {
      seen.push(message);
    });
    const app = createHttpApp({ waha, telegram: null, webhookSecret: 's3cret' });
    await withServer(app, async (base) => {
      const denied = await request(base, 'POST', '/webhook/waha', {
        json: wahaMessage,
        headers: { 'x-api-key': 'nope' },
      });
      assert.equal(denied.status, 401);
      assert.equal(seen.length, 0);

      const accepted = await request(base, 'POST', '/webhook/waha', {
        json: wahaMessage,
        headers: { 'X-Api-Key': 's3cret' },
      });
      assert.equal(accepted.status, 200);
      await waitFor(() => seen.length === 1);
      assert.equal(seen[0]?.text, 'oi');
      assert.equal(seen[0]?.channel, 'whatsapp');
    });
  });

  test('acks WAHA even when the handler throws, and ignores non-message events', async () => {
    const app = createHttpApp({
      waha: new ThrowingWaha({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' }),
      telegram: null,
      webhookSecret: '',
    });
    await withServer(app, async (base) => {
      const res = await request(base, 'POST', '/webhook/waha', { json: wahaMessage });
      assert.equal(res.status, 200);
    });

    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const seen: IncomingMessage[] = [];
    waha.onMessage((message) => {
      seen.push(message);
    });
    const quiet = createHttpApp({ waha, telegram: null, webhookSecret: '' });
    await withServer(quiet, async (base) => {
      const res = await request(base, 'POST', '/webhook/waha', {
        json: { event: 'message.any', payload: { id: 'x', from: 'a', fromMe: false } },
      });
      assert.equal(res.status, 200);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 0);
    });
  });

  test('Telegram webhook checks the secret token and dispatches the update', async () => {
    const tg = new TelegramTransport({
      botToken: '1:abc',
      apiBaseUrl: 'http://tg.test',
      webhookSecret: 'tg-secret',
    });
    const seen: IncomingMessage[] = [];
    tg.onMessage((message) => {
      seen.push(message);
    });
    const app = createHttpApp({ waha: null, telegram: tg, webhookSecret: '' });
    await withServer(app, async (base) => {
      const probe = await request(base, 'GET', '/webhook/telegram');
      assert.equal(probe.status, 200);
      const denied = await request(base, 'POST', '/webhook/telegram', {
        json: { update_id: 1, message: { message_id: 1, chat: { id: 42 }, date: 1, text: 'oi' } },
      });
      assert.equal(denied.status, 401);

      const accepted = await request(base, 'POST', '/webhook/telegram', {
        json: { update_id: 2, message: { message_id: 2, chat: { id: 42 }, date: 1, text: 'olá' } },
        headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
      });
      assert.equal(accepted.status, 200);
      await waitFor(() => seen.length === 1);
      assert.equal(seen[0]?.text, 'olá');
      assert.equal(seen[0]?.channel, 'telegram');
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timed out waiting for webhook handler');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
