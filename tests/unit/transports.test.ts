import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TelegramTransport } from '../../src/transport/TelegramTransport.js';
import { TransportRouter } from '../../src/transport/TransportRouter.js';
import { WahaTransport } from '../../src/transport/WahaTransport.js';
import type { IncomingMessage } from '../../src/transport/MessageTransport.js';
import { FakeTransport } from '../helpers/fakes.js';
import { jsonResponse, useFetch } from '../helpers/fetch-mock.js';

describe('TransportRouter', { concurrency: 1 }, () => {
  test('routes by channel and rejects an unconfigured one', () => {
    const router = new TransportRouter();
    const whatsapp = new FakeTransport('whatsapp');
    router.register(whatsapp);
    assert.equal(router.get('whatsapp'), whatsapp);
    assert.equal(router.has('telegram'), false);
    assert.deepEqual(router.all(), [whatsapp]);
    assert.throws(() => router.get('telegram'), /telegram/);
  });
});

describe('WahaTransport', { concurrency: 1 }, () => {
  test('dispatches inbound chat messages and ignores echoes and other events', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test/', apiKey: 'k', session: 'default' });
    const seen: IncomingMessage[] = [];
    waha.onMessage((message) => {
      seen.push(message);
    });

    await waha.handleWebhook({ event: 'message.any', payload: { id: 'skip', from: 'a', fromMe: false } });
    await waha.handleWebhook({
      event: 'message',
      payload: { id: 'mine', from: '5511@c.us', fromMe: true, body: 'echo', timestamp: 1 },
    });
    await waha.handleWebhook({
      event: 'message',
      payload: {
        id: 'm1',
        from: '5511@c.us',
        fromMe: false,
        body: 'oi',
        timestamp: 10,
        type: 'chat',
      },
    });
    await waha.handleWebhook({
      event: 'message',
      payload: {
        id: 'm2',
        from: '5511@c.us',
        fromMe: false,
        timestamp: 11,
        type: 'ptt',
        hasMedia: true,
        media: { url: 'http://localhost:3000/api/files/a.ogg', mimetype: 'audio/ogg' },
      },
    });
    await waha.handleWebhook({
      event: 'message',
      payload: {
        id: 'm3',
        from: '5511@c.us',
        fromMe: false,
        timestamp: 12,
        hasMedia: true,
        media: { url: 'http://localhost:3000/api/files/a.png', mimetype: 'image/png' },
      },
    });

    assert.deepEqual(seen.map((m) => m.id), ['m1', 'm2', 'm3']);
    assert.equal(seen[0]?.type, 'text');
    assert.equal(seen[0]?.text, 'oi');
    assert.equal(seen[0]?.channel, 'whatsapp');
    assert.equal(seen[1]?.type, 'audio');
    assert.equal(seen[1]?.media?.mimeType, 'audio/ogg');
    assert.equal(seen[2]?.type, 'image');
  });

  test('rewrites internal media URLs onto the configured base and sends the API key', async () => {
    const waha = new WahaTransport({ baseUrl: 'https://public.example/waha/', apiKey: 'secret', session: 'default' });
    const mock = useFetch(async (url, init) => {
      assert.equal(url, 'https://public.example/waha/api/files/a.jpg');
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'secret');
      return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    try {
      const got = await waha.downloadMedia({
        id: 'm',
        channel: 'whatsapp',
        chatId: '5511@c.us',
        from: '5511@c.us',
        type: 'image',
        timestamp: 1,
        fromMe: false,
        raw: {},
        media: { url: 'http://localhost:3000/api/files/a.jpg', mimeType: 'image/jpeg' },
      });
      assert.equal(got.data.length, 3);
      assert.equal(got.mimeType, 'image/jpeg');
    } finally {
      mock.restore();
    }
  });

  test('decodes inlined base64 media without a request', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const got = await waha.downloadMedia({
      id: 'm',
      channel: 'whatsapp',
      chatId: '1',
      from: '1',
      type: 'image',
      timestamp: 1,
      fromMe: false,
      raw: {},
      media: { base64: Buffer.from('hi').toString('base64'), mimeType: 'image/png' },
    });
    assert.equal(got.data.toString(), 'hi');
    assert.equal(got.mimeType, 'image/png');
  });

  test('falls back to a numbered text prompt when native buttons fail', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const mock = useFetch(async (url) => {
      if (url.endsWith('/api/sendButtons')) return new Response('no', { status: 500, statusText: 'err' });
      assert.equal(url, 'http://waha.test/api/sendText');
      return jsonResponse({ id: 'sent-1' });
    });
    try {
      const id = await waha.sendButtons('5511@c.us', 'Posso salvar?', [
        { id: 'accept', title: 'Aceitar' },
        { id: 'reject', title: 'Recusar' },
      ]);
      assert.equal(id, 'sent-1');
      const textCall = mock.calls.find((c) => c.url.endsWith('/api/sendText'));
      const body = JSON.parse(String(textCall?.init?.body)) as { text: string; chatId: string };
      assert.equal(body.chatId, '5511@c.us');
      assert.match(body.text, /Posso salvar\?\n\n1\. Aceitar\n2\. Recusar/);
    } finally {
      mock.restore();
    }
  });

  test('resolves @lid targets to a phone JID and caches the lookup', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    const mock = useFetch(async (url, init) => {
      if (url.includes('/lids/')) return jsonResponse({ pn: '5511999999999@c.us' });
      const body = JSON.parse(String(init?.body)) as { chatId: string };
      assert.equal(body.chatId, '5511999999999@c.us');
      return jsonResponse({ id: 'ok' });
    });
    try {
      await waha.sendText('abc@lid', 'oi');
      await waha.sendText('abc@lid', 'de novo');
      const lookups = mock.calls.filter((c) => c.url.includes('/lids/'));
      assert.equal(lookups.length, 1);
      assert.match(lookups[0]!.url, /\/api\/default\/lids\/abc%40lid$/);
    } finally {
      mock.restore();
    }
  });

  test('sendImage requires bytes or a url', async () => {
    const waha = new WahaTransport({ baseUrl: 'http://waha.test', apiKey: 'k', session: 'default' });
    await assert.rejects(() => waha.sendImage('5511@c.us', {}), /url or data/);
  });
});

describe('TelegramTransport', { concurrency: 1 }, () => {
  test('requires a bot token and normalizes a bare webhook origin onto the served path', () => {
    assert.throws(() => new TelegramTransport({ botToken: '' }), /bot token/);
    const bare = new TelegramTransport({ botToken: '1:abc', webhookUrl: 'https://bot.example.com' });
    assert.equal(bare.usesWebhook, true);
    const explicit = new TelegramTransport({
      botToken: '1:abc',
      webhookUrl: 'https://bot.example.com/ignored',
    });
    assert.equal(explicit.usesWebhook, true);
    const polling = new TelegramTransport({ botToken: '1:abc', webhookUrl: 'not a url' });
    assert.equal(polling.usesWebhook, false);
  });

  test('start() in webhook mode registers the canonical path', async () => {
    const tg = new TelegramTransport({
      botToken: '1:abc',
      apiBaseUrl: 'http://tg.test',
      webhookUrl: 'https://bot.example.com',
      webhookSecret: 'sek',
    });
    const mock = useFetch(async () => jsonResponse({ ok: true, result: { id: 1, username: 'bykonz' } }));
    try {
      await tg.start();
      const setWebhook = mock.calls.find((c) => c.url.endsWith('/setWebhook'));
      const body = JSON.parse(String(setWebhook?.init?.body)) as { url: string; secret_token: string };
      assert.equal(body.url, 'https://bot.example.com/webhook/telegram');
      assert.equal(body.secret_token, 'sek');
    } finally {
      mock.restore();
      await tg.stop();
    }
  });

  test('normalizes text, photos, voice, and ignores other bots', async () => {
    const tg = new TelegramTransport({ botToken: '1:abc', apiBaseUrl: 'http://tg.test' });
    const seen: IncomingMessage[] = [];
    tg.onMessage((message) => {
      seen.push(message);
    });
    const mock = useFetch(async () => jsonResponse({ ok: true, result: { file_path: 'photos/big.jpg' } }));
    try {
      await tg.handleWebhook({
        update_id: 1,
        message: { message_id: 10, chat: { id: 42 }, date: 5, text: 'oi', from: { id: 42, is_bot: true } },
      });
      await tg.handleWebhook({
        update_id: 2,
        message: { message_id: 11, chat: { id: 42 }, date: 6, text: 'olá' },
      });
      await tg.handleWebhook({
        update_id: 3,
        message: {
          message_id: 12,
          chat: { id: 42 },
          date: 7,
          caption: 'frente',
          photo: [
            { file_id: 'small', file_unique_id: 's', width: 10, height: 10 },
            { file_id: 'big', file_unique_id: 'b', width: 100, height: 100 },
          ],
        },
      });
      await tg.handleWebhook({
        update_id: 4,
        message: {
          message_id: 13,
          chat: { id: 42 },
          date: 8,
          voice: { file_id: 'v', mime_type: 'audio/ogg' },
        },
      });
      assert.deepEqual(seen.map((m) => m.type), ['text', 'image', 'audio']);
      assert.equal(seen[0]?.text, 'olá');
      assert.equal(seen[0]?.channel, 'telegram');
      assert.equal(seen[0]?.chatId, '42');
      assert.equal(seen[1]?.text, 'frente');
      assert.match(seen[1]?.media?.url ?? '', /\/file\/bot1:abc\/photos\/big\.jpg$/);
      assert.equal(seen[2]?.media?.mimeType, 'audio/ogg');
      const fileCalls = mock.calls.filter((c) => c.url.endsWith('/getFile'));
      assert.equal(fileCalls.length, 2);
      const firstFile = JSON.parse(String(fileCalls[0]?.init?.body)) as { file_id: string };
      assert.equal(firstFile.file_id, 'big');
    } finally {
      mock.restore();
    }
  });

  test('callback taps come back as the button index', async () => {
    const tg = new TelegramTransport({ botToken: '1:abc', apiBaseUrl: 'http://tg.test' });
    const seen: IncomingMessage[] = [];
    tg.onMessage((message) => {
      seen.push(message);
    });
    const mock = useFetch(async () => jsonResponse({ ok: true, result: true }));
    try {
      await tg.handleWebhook({
        update_id: 5,
        callback_query: {
          id: 'cq1',
          from: { id: 42 },
          data: '2',
          message: { message_id: 3, chat: { id: 99 }, date: 1 },
        },
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.type, 'text');
      assert.equal(seen[0]?.text, '2');
      assert.equal(seen[0]?.chatId, '99');
      assert.equal(seen[0]?.id, 'cb:cq1');
    } finally {
      mock.restore();
    }
  });

  test('outbound text strips WhatsApp emphasis and buttons use 1-based callback data', async () => {
    const tg = new TelegramTransport({ botToken: '1:abc', apiBaseUrl: 'http://tg.test' });
    const mock = useFetch(async () => jsonResponse({ ok: true, result: { message_id: 7 } }));
    try {
      await tg.sendText('42', 'Olá *Ana*, email john_doe@x.com e _itálico_.');
      await tg.sendButtons('42', 'Posso salvar?', [
        { id: 'accept', title: 'Aceitar' },
        { id: 'reject', title: 'Recusar' },
      ]);
      const bodies = mock.calls.map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
      assert.equal(bodies[0]?.text, 'Olá Ana, email john_doe@x.com e itálico.');
      const markup = bodies[1]?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      assert.deepEqual(markup.inline_keyboard[0]?.map((b) => b.callback_data), ['1', '2']);
      assert.equal(markup.inline_keyboard[0]?.[0]?.text, 'Aceitar');
    } finally {
      mock.restore();
    }
  });

  test('downloadMedia fetches the file URL', async () => {
    const tg = new TelegramTransport({ botToken: '1:abc', apiBaseUrl: 'http://tg.test' });
    const mock = useFetch(async () => new Response(Uint8Array.from([9]), { status: 200, headers: { 'content-type': 'audio/ogg' } }));
    try {
      const got = await tg.downloadMedia({
        id: '13',
        channel: 'telegram',
        chatId: '42',
        from: '42',
        type: 'audio',
        timestamp: 1,
        fromMe: false,
        raw: {},
        media: { url: 'http://tg.test/file/bot1:abc/voice.ogg', mimeType: 'audio/ogg' },
      });
      assert.equal(got.data[0], 9);
      assert.equal(got.mimeType, 'audio/ogg');
    } finally {
      mock.restore();
    }
  });
});
