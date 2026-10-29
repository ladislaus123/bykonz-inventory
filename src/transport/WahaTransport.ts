/**
 * WahaTransport — v1 implementation of MessageTransport backed by WAHA,
 * the unofficial WhatsApp HTTP API (https://waha.devlike.pro).
 *
 * WAHA is webhook-based for inbound and REST for outbound:
 *   - Inbound:  WAHA POSTs events to your webhook URL; call handleWebhook(body).
 *   - Outbound: POST /api/sendText, /api/sendImage, etc. with header X-Api-Key.
 */

import { log } from '../log.js';
import type {
  ChatId,
  IncomingMessage,
  IncomingMessageType,
  MessageHandler,
  MessageTransport,
  ReplyButton,
  SendImageOptions,
} from './MessageTransport.js';

export interface WahaConfig {
  baseUrl: string; // e.g. http://localhost:3000
  apiKey: string; // X-Api-Key
  session: string; // e.g. "default"
}

/** Shape of the WAHA "message" event payload (subset we rely on). */
interface WahaMessagePayload {
  id: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  body?: string;
  hasMedia?: boolean;
  type?: string;
  media?: { url?: string; mimetype?: string; filename?: string } | null;
}

interface WahaEvent {
  event?: string;
  session?: string;
  payload?: WahaMessagePayload;
}

export class WahaTransport implements MessageTransport {
  private readonly cfg: WahaConfig;
  private readonly handlers: MessageHandler[] = [];
  /** Cache of resolved @lid -> @c.us phone JIDs. */
  private readonly lidToPn = new Map<string, string>();

  constructor(cfg: WahaConfig) {
    // Strip any trailing slash so `${baseUrl}/api/...` never becomes `//api/...`.
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
  }

  /**
   * On GOWS, sending to a "<n>@lid" chatId misroutes to Status/Stories. Resolve
   * it to the real "<phone>@c.us" via WAHA's /lids/{lid} endpoint before sending.
   * Falls back to the original id if resolution fails (logged, non-fatal).
   */
  private async resolveTarget(chatId: ChatId): Promise<ChatId> {
    if (!chatId.endsWith('@lid')) return chatId;
    const cached = this.lidToPn.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.api<{ pn?: string; phoneNumber?: string; id?: string }>(
        `/api/${encodeURIComponent(this.cfg.session)}/lids/${encodeURIComponent(chatId)}`,
        'GET',
      );
      const pn = res?.pn ?? res?.phoneNumber ?? res?.id;
      if (pn && pn.endsWith('@c.us')) {
        this.lidToPn.set(chatId, pn);
        log('waha', `resolved ${chatId} -> ${pn}`);
        return pn;
      }
      log('waha', `lid resolve: no @c.us pn for ${chatId}`, res);
    } catch (err) {
      log('waha', `lid resolve failed for ${chatId}: ${(err as Error).message}`);
    }
    return chatId;
  }

  async start(): Promise<void> {
    // Webhook-driven: nothing to open. We just sanity-check the session exists.
    // (Non-fatal — WAHA may still be booting / scanning the QR code.)
    try {
      await this.api(`/api/sessions/${encodeURIComponent(this.cfg.session)}`, 'GET');
    } catch {
      // ignore; session may not be started yet
    }
  }

  async stop(): Promise<void> {
    this.handlers.length = 0;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Entry point your HTTP server calls with the raw WAHA webhook body.
   * Normalizes "message" events and fans them out to registered handlers.
   */
  async handleWebhook(body: unknown): Promise<void> {
    const evt = body as WahaEvent;
    // Process only 'message' (incoming). WAHA also emits 'message.any' for the
    // same message (incl. our own echoes), which would double-process it.
    if (!evt || evt.event !== 'message') {
      log('waha', `skip: event "${evt?.event}" (only 'message' is processed)`);
      return;
    }
    const p = evt.payload;
    if (!p || !p.id) {
      log('waha', 'skip: event has no payload.id');
      return;
    }

    log('waha', 'raw payload', JSON.stringify(p).slice(0, 900));
    const message = this.normalize(p);
    // message.any also fires for our own outbound echoes; skip those.
    if (message.fromMe) {
      log('waha', `skip: message ${message.id} is fromMe`);
      return;
    }

    log(
      'waha',
      `dispatch message id=${message.id} from=${message.from} type=${message.type} hasMedia=${Boolean(
        message.media,
      )}`,
    );
    await Promise.all(this.handlers.map((h) => h(message)));
  }

  private normalize(p: WahaMessagePayload): IncomingMessage {
    const message: IncomingMessage = {
      id: p.id,
      chatId: p.from,
      from: p.from,
      type: mapType(p.type, p.hasMedia, p.media?.mimetype),
      timestamp: p.timestamp ?? Math.floor(Date.now() / 1000),
      fromMe: Boolean(p.fromMe),
      raw: p,
    };
    if (p.body) message.text = p.body;
    if (p.media?.url || p.media?.mimetype) {
      message.media = {
        ...(p.media.url ? { url: p.media.url } : {}),
        ...(p.media.mimetype ? { mimeType: p.media.mimetype } : {}),
        ...(p.media.filename ? { filename: p.media.filename } : {}),
      };
    }
    return message;
  }

  async sendText(chatId: ChatId, text: string): Promise<string> {
    const target = await this.resolveTarget(chatId);
    const res = await this.api<{ id?: string }>('/api/sendText', 'POST', {
      session: this.cfg.session,
      chatId: target,
      text,
    });
    return res?.id ?? '';
  }

  async sendImage(chatId: ChatId, image: SendImageOptions): Promise<string> {
    const file: Record<string, unknown> = {
      mimetype: image.mimeType ?? 'image/jpeg',
      filename: image.filename ?? 'image.jpg',
    };
    if (image.url) file.url = image.url;
    else if (image.data) file.data = image.data.toString('base64');
    else throw new Error('sendImage requires either url or data');

    const target = await this.resolveTarget(chatId);
    const res = await this.api<{ id?: string }>('/api/sendImage', 'POST', {
      session: this.cfg.session,
      chatId: target,
      file,
      caption: image.caption,
    });
    return res?.id ?? '';
  }

  /**
   * Native WhatsApp buttons are unreliable over unofficial APIs, so we try
   * WAHA's /api/sendButtons and, on any failure, fall back to a numbered text
   * prompt. Either way the user's tap/typed reply comes back as a text message
   * to be matched against the button ids/titles by the flow layer.
   */
  async sendButtons(chatId: ChatId, body: string, buttons: ReplyButton[]): Promise<string> {
    const target = await this.resolveTarget(chatId);
    try {
      const res = await this.api<{ id?: string }>('/api/sendButtons', 'POST', {
        session: this.cfg.session,
        chatId: target,
        header: '',
        body,
        buttons: buttons.map((b) => ({ id: b.id, body: b.title })),
      });
      return res?.id ?? '';
    } catch {
      const numbered = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
      return this.sendText(chatId, `${body}\n\n${numbered}`);
    }
  }

  async downloadMedia(message: IncomingMessage): Promise<{ data: Buffer; mimeType: string }> {
    if (message.media?.base64) {
      return {
        data: Buffer.from(message.media.base64, 'base64'),
        mimeType: message.media.mimeType ?? 'application/octet-stream',
      };
    }
    const rawUrl = message.media?.url;
    if (!rawUrl) throw new Error(`message ${message.id} has no downloadable media`);

    // WAHA often returns an internal host (http://localhost:3000/api/files/...).
    // Rewrite it onto the configured public base so our app can actually reach it.
    let url = rawUrl;
    try {
      const u = new URL(rawUrl);
      url = `${this.cfg.baseUrl}${u.pathname}${u.search}`;
    } catch {
      /* not an absolute URL; use as-is */
    }
    if (url !== rawUrl) log('waha', `media url rewritten -> ${url}`);

    const res = await fetch(url, { headers: { 'X-Api-Key': this.cfg.apiKey } });
    if (!res.ok) throw new Error(`downloadMedia failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType =
      message.media?.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream';
    return { data: buf, mimeType };
  }

  async sendTyping(chatId: ChatId, on: boolean): Promise<void> {
    await this.api(on ? '/api/startTyping' : '/api/stopTyping', 'POST', {
      session: this.cfg.session,
      chatId,
    }).catch(() => undefined);
  }

  async markSeen(message: IncomingMessage): Promise<void> {
    await this.api('/api/sendSeen', 'POST', {
      session: this.cfg.session,
      chatId: message.chatId,
      messageId: message.id,
    }).catch(() => undefined);
  }

  private async api<T = unknown>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.cfg.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WAHA ${method} ${path} -> ${res.status} ${res.statusText} ${detail}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function mapType(
  wahaType: string | undefined,
  hasMedia: boolean | undefined,
  mimetype: string | undefined,
): IncomingMessageType {
  switch (wahaType) {
    case 'image':
      return 'image';
    case 'document':
      return 'document';
    case 'audio':
    case 'ptt':
    case 'voice':
      return 'audio';
    case 'video':
      return 'video';
    case 'chat':
    case 'text':
      return 'text';
  }
  // WAHA didn't give a usable `type` — infer from the media mimetype.
  if (mimetype) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype === 'application/pdf') return 'document';
  }
  return hasMedia ? 'other' : 'text';
}
