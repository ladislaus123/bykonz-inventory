/**
 * OpenRouterChat — minimal chat-completions client for the agent loop.
 * Supports vision (image_url content parts), tool calling, and OpenRouter's
 * built-in web-search plugin. Shape follows the OpenAI chat API that OpenRouter
 * exposes at /chat/completions.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  /** e.g. [{ id: 'web', max_results: 5 }] to enable OpenRouter web search. */
  plugins?: Array<Record<string, unknown>>;
}

interface ChatResponse {
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
}

export class OpenRouterChat {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  async complete(req: ChatRequest): Promise<ChatMessage> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'bykonz-agent',
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter chat ${res.status} ${res.statusText}: ${detail}`);
    }
    const body = (await res.json()) as ChatResponse;
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('OpenRouter chat: empty response');
    return msg;
  }
}
