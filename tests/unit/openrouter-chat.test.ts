import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OpenRouterChat, type ChatMessage } from '../../src/agent/OpenRouterChat.js';
import { jsonResponse, useFetch } from '../helpers/fetch-mock.js';

describe('OpenRouterChat', { concurrency: 1 }, () => {
  test('posts the chat request with the agent title and bearer token', async () => {
    const chat = new OpenRouterChat('or-key', 'https://llm.test/v1');
    const message: ChatMessage = { role: 'assistant', content: 'pong' };
    const mock = useFetch(async (url, init) => {
      assert.equal(url, 'https://llm.test/v1/chat/completions');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer or-key');
      assert.equal(headers['X-Title'], 'bykonz-agent');
      const body = JSON.parse(String(init?.body)) as { model: string; temperature: number };
      assert.equal(body.model, 'google/gemini-2.5-flash');
      assert.equal(body.temperature, 0);
      return jsonResponse({ choices: [{ message, finish_reason: 'stop' }] });
    });
    try {
      const got = await chat.complete({
        model: 'google/gemini-2.5-flash',
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      });
      assert.deepEqual(got, message);
    } finally {
      mock.restore();
    }
  });

  test('rejects an empty choice list', async () => {
    const chat = new OpenRouterChat('or-key', 'https://llm.test/v1');
    const mock = useFetch(async () => jsonResponse({ choices: [] }));
    try {
      await assert.rejects(
        () => chat.complete({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }),
        /empty response/,
      );
    } finally {
      mock.restore();
    }
  });

  test('includes the response body on HTTP errors', async () => {
    const chat = new OpenRouterChat('or-key', 'https://llm.test/v1');
    const mock = useFetch(async () => new Response('quota', { status: 429, statusText: 'Too Many Requests' }));
    try {
      await assert.rejects(
        () => chat.complete({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }),
        /429[\s\S]*quota/,
      );
    } finally {
      mock.restore();
    }
  });
});
