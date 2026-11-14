import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DeepgramClient } from '../../src/voice/DeepgramClient.js';
import { liveEnabled, requireEnv, wavTone } from '../helpers/live.js';

describe('live Deepgram', { concurrency: 1, skip: liveEnabled() ? false : 'set RUN_LIVE_TESTS=1 (npm run test:live or npm run test:ci)' }, () => {
  test('pre-recorded listen accepts a wav and returns a transcript string', { timeout: 60_000 }, async () => {
    const client = new DeepgramClient({
      apiKey: requireEnv('DEEPGRAM_API_KEY'),
      model: process.env.DEEPGRAM_MODEL ?? 'nova-2',
      language: process.env.DEEPGRAM_LANGUAGE ?? 'pt',
    });
    const transcript = await client.transcribe(wavTone(), 'audio/wav');
    assert.equal(typeof transcript, 'string');
  });
});
