/**
 * TransportRouter — holds every active MessageTransport keyed by its channel,
 * so the flow and worker can send a reply out on the SAME backend a message
 * arrived on. This is what lets WhatsApp (WAHA) and Telegram run simultaneously:
 * a Telegram message is answered on Telegram, a WhatsApp one on WhatsApp.
 */

import type { Channel, MessageTransport } from './MessageTransport.js';

export class TransportRouter {
  private readonly byChannel = new Map<Channel, MessageTransport>();

  register(transport: MessageTransport): void {
    this.byChannel.set(transport.channel, transport);
  }

  /** The transport for a channel, or throw if that channel isn't configured. */
  get(channel: Channel): MessageTransport {
    const t = this.byChannel.get(channel);
    if (!t) throw new Error(`no transport registered for channel "${channel}"`);
    return t;
  }

  has(channel: Channel): boolean {
    return this.byChannel.has(channel);
  }

  all(): MessageTransport[] {
    return [...this.byChannel.values()];
  }
}
