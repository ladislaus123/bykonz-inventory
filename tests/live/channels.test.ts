import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configuredDrivers, liveEnabled, requireEnv } from '../helpers/live.js';

const live = liveEnabled();
const drivers = configuredDrivers();
const checkWaha = Boolean(process.env.WAHA_BASE_URL) || drivers.includes('waha');
const checkTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN) || drivers.includes('telegram');

describe('live messaging channels', { concurrency: 1, skip: live ? false : 'set RUN_LIVE_TESTS=1 (npm run test:live or npm run test:ci)' }, () => {
  test('WAHA session endpoint answers', { timeout: 30_000, skip: checkWaha ? false : 'WAHA_BASE_URL or TRANSPORT_DRIVER=waha not set' }, async () => {
    const base = requireEnv('WAHA_BASE_URL').replace(/\/+$/, '');
    const session = process.env.WAHA_SESSION ?? 'default';
    const headers: Record<string, string> = {};
    if (process.env.WAHA_API_KEY) headers['X-Api-Key'] = process.env.WAHA_API_KEY;
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}`, { headers });
    assert.ok(res.ok, `WAHA session check failed: HTTP ${res.status}`);
  });

  test('Telegram getMe answers', { timeout: 30_000, skip: checkTelegram ? false : 'TELEGRAM_BOT_TOKEN or TRANSPORT_DRIVER=telegram not set' }, async () => {
    const token = requireEnv('TELEGRAM_BOT_TOKEN');
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: { username?: string } } | null;
    assert.equal(body?.ok, true, body?.description ?? `Telegram getMe failed: HTTP ${res.status}`);
    assert.ok(body?.result?.username);
  });
});
