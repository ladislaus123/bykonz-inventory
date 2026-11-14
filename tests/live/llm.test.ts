import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OpenRouterChat } from '../../src/agent/OpenRouterChat.js';
import { EmbeddingClient } from '../../src/embeddings/EmbeddingClient.js';
import { liveEnabled, requireEnv } from '../helpers/live.js';

describe('live OpenRouter', { concurrency: 1, skip: liveEnabled() ? false : 'set RUN_LIVE_TESTS=1 (npm run test:live or npm run test:ci)' }, () => {
  test('embeddings endpoint returns a vector of the configured length', { timeout: 120_000 }, async () => {
    const client = new EmbeddingClient({
      apiKey: requireEnv('OPENROUTER_API_KEY'),
      model: process.env.EMBEDDING_MODEL ?? 'google/gemini-embedding-2',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? '1536'),
    });
    const vec = await client.embedText('teste de conectividade bykonz');
    assert.equal(vec.length, client.dimensions);
    assert.ok(vec.every((n) => typeof n === 'number' && Number.isFinite(n)));
  });

  test('chat completions endpoint returns a non-empty reply', { timeout: 120_000 }, async () => {
    const chat = new OpenRouterChat(requireEnv('OPENROUTER_API_KEY'));
    const message = await chat.complete({
      model: process.env.AGENT_MODEL ?? 'google/gemini-2.5-flash',
      temperature: 0,
      messages: [{ role: 'user', content: 'Responda apenas com a palavra pong.' }],
    });
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    assert.ok(text.trim().length > 0, 'OpenRouter chat returned an empty message');
  });
});
