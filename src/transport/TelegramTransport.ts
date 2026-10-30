/**
 * TelegramTransport — MessageTransport backed by the Telegram Bot API
 * (bot created via @BotFather, e.g. t.me/Bykonzbusinessbot).
 *
 * Unlike WAHA, this transport is self-contained: start() opens a long-polling
 * getUpdates loop, so it needs NO public webhook URL. Inbound text/photo/document
 * messages and inline-button taps are normalized into IncomingMessage and fanned
 * out to the same handler the WhatsApp flow registers.
 *
 * Button contract: Telegram inline-keyboard taps arrive as callback_query updates,
 * not messages. We set each button's callback_data to its 1-based index and
 * synthesize a text IncomingMessage carrying that number — mirroring the numbered
 * text fallback — so the flow's existing "1"/"2" parsing works unchanged.
 */

import { log, logErr } from '../log.js';
import type {
  Channel,
  ChatId,
  IncomingMessage,
  MessageHandler,
  MessageTransport,
  ReplyButton,
  SendImageOptions,
} from './MessageTransport.js';

export interface TelegramConfig {
  botToken: string;
  /** Long-poll timeout in seconds (Telegram holds the request open this long). */
  pollTimeout?: number;
  /** Override for self-hosted Bot API servers; defaults to api.telegram.org. */
  apiBaseUrl?: string;
  /**
   * Public HTTPS URL Telegram should POST updates to. When set, the transport
   * runs in WEBHOOK mode (registers this URL via setWebhook on start, no polling)
   * and the server feeds inbound updates through handleWebhook().
   */
  webhookUrl?: string;
  /** Optional secret echoed back by Telegram in X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret?: string;
}

/* ---- subset of the Telegram Bot API wire shapes we read ---- */
interface TgUser { id: number; is_bot?: boolean; first_name?: string; username?: string }
interface TgChat { id: number; type?: string }
interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }
interface TgDocument { file_id: string; file_name?: string; mime_type?: string }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
interface TgResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number }

export class TelegramTransport implements MessageTransport {
  readonly channel: Channel = 'telegram';
  private readonly token: string;
  private readonly pollTimeout: number;
  private readonly apiBase: string;
  private readonly fileBase: string;
  private readonly webhookUrl: string;
  readonly webhookSecret: string;
  private readonly handlers: MessageHandler[] = [];

  private running = false;
  private offset = 0;
  private loop: Promise<void> | null = null;

  constructor(cfg: TelegramConfig) {
    if (!cfg.botToken) throw new Error('TelegramTransport requires a bot token');
    this.token = cfg.botToken;
    this.pollTimeout = cfg.pollTimeout ?? 30;
    this.webhookUrl = cfg.webhookUrl?.trim() ?? '';
    this.webhookSecret = cfg.webhookSecret?.trim() ?? '';
    const base = (cfg.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.apiBase = `${base}/bot${this.token}`;
    this.fileBase = `${base}/file/bot${this.token}`;
  }

  /** True when configured for webhook delivery (server routes updates in). */
  get usesWebhook(): boolean {
    return this.webhookUrl.length > 0;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const me = await this.api<TgUser>('getMe').catch(() => null);

    if (this.usesWebhook) {
      // Register the public URL; Telegram then POSTs updates to our server.
      await this.api('setWebhook', {
        url: this.webhookUrl,
        allowed_updates: ['message', 'callback_query'],
        ...(this.webhookSecret ? { secret_token: this.webhookSecret } : {}),
      });
      log('telegram', `started as @${me?.username ?? '?'} in webhook mode -> ${this.webhookUrl}`);
      return;
    }

    // Polling mode: drop any existing webhook so getUpdates is allowed.
    await this.api('deleteWebhook', { drop_pending_updates: false }).catch(() => undefined);
    log('telegram', `started polling as @${me?.username ?? '?'} (timeout ${this.pollTimeout}s)`);
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
    this.handlers.length = 0;
  }

  /**
   * Feed one raw Telegram Update (the webhook request body) into the flow.
   * Used only in webhook mode; the server wires POST /webhook/telegram to this.
   */
  async handleWebhook(body: unknown): Promise<void> {
    await this.dispatch(body as TgUpdate);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /* ======================= inbound (long polling) ======================= */

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates ?? []) {
          this.offset = u.update_id + 1;
          await this.dispatch(u).catch((err) => logErr('telegram', 'dispatch failed', err));
        }
      } catch (err) {
        if (!this.running) break;
        logErr('telegram', 'getUpdates failed; backing off 2s', err);
        await sleep(2000);
      }
    }
  }

  private async dispatch(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.onCallback(update.callback_query);
      return;
    }
    if (!update.message) return;
    const message = await this.normalize(update.message);
    if (!message) return;
    log('telegram', `dispatch message id=${message.id} from=${message.from} type=${message.type}`);
    await Promise.all(this.handlers.map((h) => h(message)));
  }

  /** An inline-button tap: ack it and feed the chosen index back as a text message. */
  private async onCallback(cq: TgCallbackQuery): Promise<void> {
    await this.api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => undefined);
    const chat = cq.message?.chat;
    if (!chat) return;
    const chatId = String(chat.id);
    const message: IncomingMessage = {
      id: `cb:${cq.id}`,
      channel: this.channel,
      chatId,
      from: chatId,
      type: 'text',
      text: cq.data ?? '',
      timestamp: cq.message?.date ?? Math.floor(Date.now() / 1000),
      fromMe: false,
      raw: cq,
    };
    log('telegram', `dispatch callback from=${chatId} data=${cq.data ?? ''}`);
    await Promise.all(this.handlers.map((h) => h(message)));
  }

  private async normalize(m: TgMessage): Promise<IncomingMessage | null> {
    if (m.from?.is_bot) return null; // ignore other bots / our own echoes
    // In private chats chat.id === user id; use it for both so sends route back.
    const chatId = String(m.chat.id);
    const message: IncomingMessage = {
      id: String(m.message_id),
      channel: this.channel,
      chatId,
      from: chatId,
      type: 'text',
      timestamp: m.date ?? Math.floor(Date.now() / 1000),
      fromMe: false,
      raw: m,
    };

    if (m.photo?.length) {
      // photo is an array of sizes, ascending; the last is the highest resolution.
      const largest = m.photo[m.photo.length - 1]!;
      const url = await this.fileUrl(largest.file_id);
      message.type = 'image';
      if (url) message.media = { url, mimeType: 'image/jpeg' };
      if (m.caption) message.text = m.caption;
      return message;
    }

    if (m.document) {
      const url = await this.fileUrl(m.document.file_id);
      const mime = m.document.mime_type ?? 'application/octet-stream';
      message.type = mime.startsWith('image/') ? 'image' : 'document';
      if (url) message.media = { url, mimeType: mime, filename: m.document.file_name };
      if (m.caption) message.text = m.caption;
      return message;
    }

    if (typeof m.text === 'string') {
      message.type = 'text';
      message.text = m.text;
      return message;
    }

    // Unsupported content (voice/video/sticker/…): surface as a non-text, no-media
    // message so the flow can prompt for a photo/text.
    message.type = 'other';
    return message;
  }

  /** Resolve a Telegram file_id to a downloadable URL (token embedded, no auth header). */
  private async fileUrl(fileId: string): Promise<string | undefined> {
    try {
      const file = await this.api<{ file_path?: string }>('getFile', { file_id: fileId });
      if (!file?.file_path) return undefined;
      return `${this.fileBase}/${file.file_path}`;
    } catch (err) {
      logErr('telegram', `getFile failed for ${fileId}`, err);
      return undefined;
    }
  }

  async downloadMedia(message: IncomingMessage): Promise<{ data: Buffer; mimeType: string }> {
    const url = message.media?.url;
    if (!url) throw new Error(`message ${message.id} has no downloadable media`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`downloadMedia failed: ${res.status} ${res.statusText}`);
    const data = Buffer.from(await res.arrayBuffer());
    const mimeType =
      message.media?.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream';
    return { data, mimeType };
  }

  /* ======================= outbound ======================= */

  async sendText(chatId: ChatId, text: string): Promise<string> {
    const res = await this.api<TgMessage>('sendMessage', { chat_id: chatId, text });
    return res ? String(res.message_id) : '';
  }

  async sendImage(chatId: ChatId, image: SendImageOptions): Promise<string> {
    if (image.url) {
      // Telegram fetches the URL server-side (works for public signed URLs).
      const res = await this.api<TgMessage>('sendPhoto', {
        chat_id: chatId,
        photo: image.url,
        ...(image.caption ? { caption: image.caption } : {}),
      });
      return res ? String(res.message_id) : '';
    }
    if (image.data) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (image.caption) form.append('caption', image.caption);
      const blob = new Blob([image.data], { type: image.mimeType ?? 'image/jpeg' });
      form.append('photo', blob, image.filename ?? 'image.jpg');
      const res = await this.apiForm<TgMessage>('sendPhoto', form);
      return res ? String(res.message_id) : '';
    }
    throw new Error('sendImage requires either url or data');
  }

  async sendButtons(chatId: ChatId, body: string, buttons: ReplyButton[]): Promise<string> {
    // callback_data = 1-based index, so taps come back as "1"/"2" like the
    // numbered fallback the flow already understands.
    const inline_keyboard = [
      buttons.map((b, i) => ({ text: b.title, callback_data: String(i + 1) })),
    ];
    const res = await this.api<TgMessage>('sendMessage', {
      chat_id: chatId,
      text: body,
      reply_markup: { inline_keyboard },
    });
    return res ? String(res.message_id) : '';
  }

  async sendTyping(chatId: ChatId, on: boolean): Promise<void> {
    // Telegram has no "stop typing"; the indicator auto-clears after ~5s or on send.
    if (!on) return;
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
  }

  async markSeen(): Promise<void> {
    // Telegram bots cannot mark messages as read; no-op.
  }

  /* ======================= HTTP ======================= */

  private async api<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T> {
    // Allow the long-poll request a little longer than its server-side timeout.
    const ctrl = new AbortController();
    const timeoutMs = (this.pollTimeout + 15) * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      return await this.unwrap<T>(method, res);
    } finally {
      clearTimeout(timer);
    }
  }

  private async apiForm<T = unknown>(method: string, form: FormData): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, { method: 'POST', body: form });
    return this.unwrap<T>(method, res);
  }

  private async unwrap<T>(method: string, res: Response): Promise<T> {
    const json = (await res.json().catch(() => null)) as TgResponse<T> | null;
    if (!res.ok || !json?.ok) {
      const detail = json?.description ?? `${res.status} ${res.statusText}`;
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
    return json.result as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
