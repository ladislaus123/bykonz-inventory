import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EmbeddingClient } from '../../src/embeddings/EmbeddingClient.js';
import { jsonResponse, useFetch } from '../helpers/fetch-mock.js';

const cfg = { apiKey: 'test-key', model: 'google/gemini-embedding-2', dimensions: 4, baseUrl: 'https://embed.test/v1' };

describe('EmbeddingClient', { concurrency: 1 }, () => {
  test('pins dimensions, sends the bearer token, and reorders by index', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; dimensions: number; input: string[] };
      assert.equal(body.model, cfg.model);
      assert.equal(body.dimensions, 4);
      assert.deepEqual(body.input, ['a', 'b']);
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, 'Bearer test-key');
      return jsonResponse({
        data: [
          { index: 1, embedding: [0, 1, 0, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
        model: cfg.model,
      });
    });
    try {
      const vectors = await client.embedTexts(['a', 'b']);
      assert.deepEqual(vectors, [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ]);
      assert.equal(mock.calls[0]?.url, 'https://embed.test/v1/embeddings');
    } finally {
      mock.restore();
    }
  });

  test('rejects a vector whose length does not match the schema', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async () => jsonResponse({ data: [{ index: 0, embedding: [1, 0] }], model: cfg.model }));
    try {
      await assert.rejects(() => client.embedText('oi'), /Expected 4-dim embeddings but got 2/);
    } finally {
      mock.restore();
    }
  });

  test('surfaces the HTTP error body', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async () => new Response('bad key', { status: 401, statusText: 'Unauthorized' }));
    try {
      await assert.rejects(() => client.embedText('oi'), /401/);
    } finally {
      mock.restore();
    }
  });

  test('embedTexts([]) does not call the network', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async () => {
      throw new Error('should not be called');
    });
    try {
      assert.deepEqual(await client.embedTexts([]), []);
      assert.equal(mock.calls.length, 0);
    } finally {
      mock.restore();
    }
  });

  test('embedText throws when the provider returns no vectors', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async () => jsonResponse({ data: [], model: cfg.model }));
    try {
      await assert.rejects(() => client.embedText('oi'), /empty response/);
    } finally {
      mock.restore();
    }
  });

  test('embedImage sends a data URL in an image content part', async () => {
    const client = new EmbeddingClient(cfg);
    const mock = useFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: Array<{ content: Array<{ type: string; image_url: { url: string } }> }>;
      };
      const part = body.input[0]?.content[0];
      assert.equal(part?.type, 'image_url');
      assert.match(part?.image_url.url ?? '', /^data:image\/png;base64,/);
      return jsonResponse({ data: [{ index: 0, embedding: [0, 1, 0, 0] }], model: cfg.model });
    });
    try {
      const vec = await client.embedImage(Buffer.from('png'), 'image/png');
      assert.deepEqual(vec, [0, 1, 0, 0]);
    } finally {
      mock.restore();
    }
  });
});
