/**
 * DeepgramClient — speech-to-text for inbound voice messages.
 *
 * WhatsApp (WAHA) and Telegram voice notes are OGG/Opus; Deepgram's pre-recorded
 * `listen` endpoint accepts the raw bytes with the original Content-Type and
 * auto-detects the container. We send the audio and read back the single best
 * transcript, which the flow then treats exactly like a typed message.
 *
 * Create a key at https://console.deepgram.com and set DEEPGRAM_API_KEY. When no
 * key is configured the flow simply asks the user to type instead (voice off).
 */

import { log, logErr } from '../log.js';

/** The capability the flow depends on; DeepgramClient is the v1 implementation. */
export interface VoiceTranscriber {
  /** Transcribe audio bytes to text. Returns '' when nothing was recognized. */
  transcribe(data: Buffer, mimeType: string): Promise<string>;
}

export interface DeepgramConfig {
  apiKey: string;
  /** Deepgram model, e.g. "nova-2" (default). */
  model?: string;
  /** BCP-47 language, e.g. "pt" for Portuguese (default). */
  language?: string;
  baseUrl?: string; // default https://api.deepgram.com
}

interface DeepgramListenResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
  };
}

export class DeepgramClient implements VoiceTranscriber {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly baseUrl: string;

  constructor(cfg: DeepgramConfig) {
    if (!cfg.apiKey) throw new Error('DeepgramClient requires an API key');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? 'nova-2';
    this.language = cfg.language ?? 'pt';
    this.baseUrl = (cfg.baseUrl ?? 'https://api.deepgram.com').replace(/\/+$/, '');
  }

  async transcribe(data: Buffer, mimeType: string): Promise<string> {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      smart_format: 'true',
      punctuate: 'true',
    });
    const res = await fetch(`${this.baseUrl}/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': mimeType || 'audio/ogg',
      },
      body: data,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logErr('deepgram', `listen ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
      throw new Error(`Deepgram transcription failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as DeepgramListenResponse;
    const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    log('deepgram', `transcribed ${data.length} bytes -> "${transcript.slice(0, 80)}"`);
    return transcript.trim();
  }
}
