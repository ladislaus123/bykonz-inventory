/**
 * Live connectivity tests talk to Supabase, OpenRouter, Deepgram, and (when
 * configured) storage / WAHA / Telegram.
 *
 * They stay off during a normal `npm test` so a laptop run never writes to the
 * project database. Turn them on with either:
 *   - `npm run test:live`          (sets RUN_LIVE_TESTS=1, reads .env)
 *   - `npm run test:ci`            (what the CI workflow runs)
 *   - RUN_LIVE_TESTS=1 in the environment
 *
 * When they are on, a missing required secret fails the run. A green CI job
 * therefore means the database, the LLM, and voice were actually reached.
 */

import 'dotenv/config';

export function liveEnabled(): boolean {
  return process.env.RUN_LIVE_TESTS === '1';
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Live connectivity tests need this secret in the CI environment (or in .env for \`npm run test:live\`).`,
    );
  }
  return value;
}

/** Comma-separated TRANSPORT_DRIVER values, lowercased. Empty when unset. */
export function configuredDrivers(): string[] {
  return (process.env.TRANSPORT_DRIVER ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** 1536-d vector with a single 1. Matches VECTOR(1536) in the schema. */
export function oneHot(dim: number, index: number): number[] {
  const v = Array.from({ length: dim }, () => 0);
  v[index] = 1;
  return v;
}

/** Short PCM WAV (quiet 440 Hz tone) so Deepgram has a real container to decode. */
export function wavTone(seconds = 0.4, sampleRate = 16000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 800);
    data.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
