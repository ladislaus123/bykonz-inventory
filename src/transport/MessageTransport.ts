/**
 * MessageTransport — the provider-agnostic messaging port.
 *
 * The rest of the app (the WhatsApp flow, the agent, the worker) depends ONLY on
 * this interface. v1 is implemented by WahaTransport (unofficial WhatsApp HTTP API);
 * a future official Cloud API / Telegram / mock transport can implement the same
 * contract without touching the flow.
 */

export type ChatId = string; // WhatsApp JID, e.g. "5511999999999@c.us"

/** Which messaging backend a message came in on / should go out on. */
export type Channel = 'whatsapp' | 'telegram';

export type IncomingMessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'other';

export interface IncomingMedia {
  /** URL served by the transport from which the bytes can be fetched. */
  url?: string;
  mimeType?: string;
  filename?: string;
  /** Some transports inline small media as base64 instead of a URL. */
  base64?: string;
}

/** A normalized inbound message, independent of the provider's wire format. */
export interface IncomingMessage {
  /** Provider message id (used for idempotency / dedupe). */
  id: string;
  /** The backend this message arrived on; replies must go out on the same one. */
  channel: Channel;
  chatId: ChatId;
  /** Sender JID; equals chatId for 1:1 chats. */
  from: ChatId;
  type: IncomingMessageType;
  text?: string;
  media?: IncomingMedia;
  /** Epoch seconds. */
  timestamp: number;
  fromMe: boolean;
  /** Raw provider payload, for debugging / fields not yet normalized. */
  raw: unknown;
}

/** A reply button for the accept/deny step. */
export interface ReplyButton {
  /** Stable id returned when the user taps it (falls back to matching the text). */
  id: string;
  title: string;
}

export interface SendImageOptions {
  /** Either a public URL or raw bytes. */
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
  caption?: string;
}

/** Handler registered via onMessage; may be async. */
export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export interface MessageTransport {
  /** The backend this transport speaks (used to route replies by channel). */
  readonly channel: Channel;

  /**
   * Begin receiving messages. For a webhook-based transport this may be a no-op
   * (messages arrive via handleWebhook); for a polling/socket transport it opens
   * the connection. Safe to call once.
   */
  start(): Promise<void>;

  /** Stop receiving and release resources. */
  stop(): Promise<void>;

  /** Register a handler for inbound messages. */
  onMessage(handler: MessageHandler): void;

  /** Send a plain text message. Returns the provider message id. */
  sendText(chatId: ChatId, text: string): Promise<string>;

  /** Send an image (by URL or bytes) with an optional caption. */
  sendImage(chatId: ChatId, image: SendImageOptions): Promise<string>;

  /**
   * Ask the user to choose among buttons (e.g. "Aceitar" / "Recusar").
   * Transports that cannot render native buttons MUST fall back to a numbered
   * text prompt and still resolve; the reply then arrives as a normal text
   * message to be matched against the button ids/titles.
   */
  sendButtons(chatId: ChatId, body: string, buttons: ReplyButton[]): Promise<string>;

  /** Fetch the bytes of an incoming message's media. */
  downloadMedia(message: IncomingMessage): Promise<{ data: Buffer; mimeType: string }>;

  /** Optional UX niceties; implementations may no-op. */
  sendTyping?(chatId: ChatId, on: boolean): Promise<void>;
  markSeen?(message: IncomingMessage): Promise<void>;
}
