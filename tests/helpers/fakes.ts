import type { ChatMessage, ChatRequest } from '../../src/agent/OpenRouterChat.js';
import type { Storage, UploadParams } from '../../src/storage/Storage.js';
import type {
  Channel,
  ChatId,
  IncomingMessage,
  MessageHandler,
  MessageTransport,
  ReplyButton,
  SendImageOptions,
} from '../../src/transport/MessageTransport.js';
import type { Embedding } from '../../src/types/domain.js';

export class FakeTransport implements MessageTransport {
  readonly sentText: Array<{ chatId: string; text: string }> = [];
  readonly sentButtons: Array<{ chatId: string; body: string; buttons: ReplyButton[] }> = [];
  readonly sentImages: Array<{ chatId: string; image: SendImageOptions }> = [];
  readonly typing: Array<{ chatId: string; on: boolean }> = [];
  readonly seen: IncomingMessage[] = [];
  bytes = Buffer.from('fake-image-bytes');
  failDownload = false;
  failSend = false;
  private seq = 0;
  private readonly handlers: MessageHandler[] = [];

  constructor(readonly channel: Channel) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.handlers.length = 0;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendText(chatId: ChatId, text: string): Promise<string> {
    if (this.failSend) throw new Error('send failed');
    this.sentText.push({ chatId, text });
    this.seq += 1;
    return `out-${this.seq}`;
  }

  async sendImage(chatId: ChatId, image: SendImageOptions): Promise<string> {
    if (this.failSend) throw new Error('send failed');
    this.sentImages.push({ chatId, image });
    this.seq += 1;
    return `out-${this.seq}`;
  }

  async sendButtons(chatId: ChatId, body: string, buttons: ReplyButton[]): Promise<string> {
    if (this.failSend) throw new Error('send failed');
    this.sentButtons.push({ chatId, body, buttons });
    this.seq += 1;
    return `out-${this.seq}`;
  }

  async downloadMedia(message: IncomingMessage): Promise<{ data: Buffer; mimeType: string }> {
    if (this.failDownload) throw new Error('download failed');
    if (message.media?.base64) {
      return {
        data: Buffer.from(message.media.base64, 'base64'),
        mimeType: message.media.mimeType ?? 'application/octet-stream',
      };
    }
    return { data: this.bytes, mimeType: message.media?.mimeType ?? 'image/jpeg' };
  }

  async sendTyping(chatId: ChatId, on: boolean): Promise<void> {
    this.typing.push({ chatId, on });
  }

  async markSeen(message: IncomingMessage): Promise<void> {
    this.seen.push(message);
  }

  lastText(): string {
    const item = this.sentText.at(-1);
    if (!item) throw new Error(`no text sent on ${this.channel}`);
    return item.text;
  }
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  readonly signed: string[] = [];

  async upload(params: UploadParams): Promise<string> {
    this.objects.set(params.key, { data: Buffer.from(params.data), contentType: params.contentType });
    return params.key;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`object not found: ${key}`);
    this.signed.push(key);
    return `https://signed.example/${expiresInSeconds}/${key}`;
  }

  getPublicUrl(key: string): string {
    return `https://public.example/${key}`;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Scripted embeddings. `queue` is consumed one vector per embedText / embedImage call. */
export class FakeEmbeddings {
  model = 'test-embedding';
  dimensions = 4;
  readonly texts: string[] = [];
  readonly images: Array<{ bytes: number; mimeType: string }> = [];
  queue: Embedding[] = [];

  async embedTexts(inputs: string[]): Promise<Embedding[]> {
    const out: Embedding[] = [];
    for (const input of inputs) out.push(await this.embedText(input));
    return out;
  }

  async embedText(input: string): Promise<Embedding> {
    this.texts.push(input);
    return this.queue.shift() ?? [1, 0, 0, 0];
  }

  async embedImage(data: Buffer, mimeType: string): Promise<Embedding> {
    this.images.push({ bytes: data.length, mimeType });
    return this.queue.shift() ?? [0, 1, 0, 0];
  }
}

/** Scripted chat completions. An empty queue fails the call (the flow treats that as a rerank fallback). */
export class ScriptedChat {
  readonly calls: ChatRequest[] = [];
  queue: ChatMessage[] = [];

  async complete(req: ChatRequest): Promise<ChatMessage> {
    this.calls.push(structuredClone(req));
    const next = this.queue.shift();
    if (!next) throw new Error(`ScriptedChat: no response scripted for model ${req.model}`);
    return structuredClone(next);
  }
}

export function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}
