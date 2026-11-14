import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DeepgramClient } from '../../src/voice/DeepgramClient.js';
import { jsonResponse, useFetch } from '../helpers/fetch-mock.js';

describe('DeepgramClient', { concurrency: 1 }, () => {
  test('refuses to construct without an API key', () => {
    assert.throws(() => new DeepgramClient({ apiKey: '' }), /API key/);
  });

  test('posts the audio bytes and returns the trimmed transcript', async () => {
    const client = new DeepgramClient({
      apiKey: 'dg-key',
      model: 'nova-2',
      language: 'pt',
      baseUrl: 'https://voice.test/',
    });
    const audio = Buffer.from('ogg-bytes');
    const mock = useFetch(async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, 'https://voice.test/v1/listen');
      assert.equal(parsed.searchParams.get('model'), 'nova-2');
      assert.equal(parsed.searchParams.get('language'), 'pt');
      assert.equal(parsed.searchParams.get('smart_format'), 'true');
      assert.equal(parsed.searchParams.get('punctuate'), 'true');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Token dg-key');
      assert.equal(headers['Content-Type'], 'audio/ogg');
      assert.equal(Buffer.from(init?.body as Buffer).toString(), 'ogg-bytes');
      return jsonResponse({
        results: { channels: [{ alternatives: [{ transcript: '  uma padaria no centro  ', confidence: 0.9 }] }] },
      });
    });
    try {
      assert.equal(await client.transcribe(audio, 'audio/ogg'), 'uma padaria no centro');
    } finally {
      mock.restore();
    }
  });

  test('returns an empty string when nothing was recognized', async () => {
    const client = new DeepgramClient({ apiKey: 'dg-key', baseUrl: 'https://voice.test' });
    const mock = useFetch(async () => jsonResponse({ results: { channels: [{ alternatives: [{}] }] } }));
    try {
      assert.equal(await client.transcribe(Buffer.from('x'), 'audio/wav'), '');
    } finally {
      mock.restore();
    }
  });

  test('throws when Deepgram rejects the request', async () => {
    const client = new DeepgramClient({ apiKey: 'dg-key', baseUrl: 'https://voice.test' });
    const mock = useFetch(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }));
    try {
      await assert.rejects(() => client.transcribe(Buffer.from('x'), 'audio/ogg'), /401/);
    } finally {
      mock.restore();
    }
  });
});
