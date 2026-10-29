/**
 * EmbeddingClient — thin wrapper over OpenRouter's embeddings endpoint for
 * google/gemini-embedding-2 (multimodal: text AND images share one space).
 *
 * CRITICAL: the model defaults to 3072 dims, so we ALWAYS send `dimensions`
 * explicitly (1536) to match VECTOR(1536) in the schema. If you change the
 * dimension here, you must re-embed the corpus and change the SQL columns.
 */

import type { Embedding } from '../types/domain.js';

export interface EmbeddingConfig {
  apiKey: string;
  model: string; // google/gemini-embedding-2
  dimensions: number; // 1536
  baseUrl?: string; // default https://openrouter.ai/api/v1
}

interface OpenRouterEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingClient {
  private readonly cfg: Required<EmbeddingConfig>;

  constructor(cfg: EmbeddingConfig) {
    this.cfg = { baseUrl: 'https://openrouter.ai/api/v1', ...cfg };
  }

  /** The model id, for recording which model produced a stored vector. */
  get model(): string {
    return this.cfg.model;
  }

  /** Configured output dimensionality (must match the VECTOR(n) columns). */
  get dimensions(): number {
    return this.cfg.dimensions;
  }

  /** Embed one or more text strings. Returns one vector per input, in order. */
  async embedTexts(inputs: string[]): Promise<Embedding[]> {
    if (inputs.length === 0) return [];
    return this.request(inputs);
  }

  /** Convenience: embed a single description string. */
  async embedText(input: string): Promise<Embedding> {
    const [vec] = await this.embedTexts([input]);
    if (!vec) throw new Error('EmbeddingClient: empty response');
    return vec;
  }

  /**
   * Embed an image using the same multimodal model, so the vector is comparable
   * to text embeddings (cross-modal search). The image is passed as a data URL
   * in OpenAI-style multimodal content parts.
   *
   * NOTE: multimodal embedding input shape over OpenRouter can vary by provider
   * routing; if your account returns an error here, check the model page and
   * adjust the content-part format. The text path above is the stable one.
   */
  async embedImage(data: Buffer, mimeType: string): Promise<Embedding> {
    const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;
    const input = [
      {
        content: [{ type: 'image_url', image_url: { url: dataUrl } }],
      },
    ];
    const [vec] = await this.request(input);
    if (!vec) throw new Error('EmbeddingClient: empty image embedding response');
    return vec;
  }

  private async request(input: unknown): Promise<Embedding[]> {
    const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        input,
        dimensions: this.cfg.dimensions, // pin to 1536 — do not omit
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter embeddings ${res.status} ${res.statusText}: ${detail}`);
    }

    const body = (await res.json()) as OpenRouterEmbeddingResponse;
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map((d) => d.embedding);

    for (const v of vectors) {
      if (v.length !== this.cfg.dimensions) {
        throw new Error(
          `Expected ${this.cfg.dimensions}-dim embeddings but got ${v.length}. ` +
            `The schema (VECTOR(${this.cfg.dimensions})) and model output must match.`,
        );
      }
    }
    return vectors;
  }
}
