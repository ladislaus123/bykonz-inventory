import { randomUUID } from 'node:crypto';

import type { EmbeddingClient } from '../../src/embeddings/EmbeddingClient.js';
import { WhatsAppFlow } from '../../src/flow.js';
import type { OpenRouterChat } from '../../src/agent/OpenRouterChat.js';
import { TransportRouter } from '../../src/transport/TransportRouter.js';
import type { Channel, IncomingMessage } from '../../src/transport/MessageTransport.js';
import type { VoiceTranscriber } from '../../src/voice/DeepgramClient.js';
import { FakeEmbeddings, FakeTransport, MemoryStorage, ScriptedChat } from './fakes.js';
import { MemoryRepository } from './memory-repo.js';

export const CHAT = '5511999999999@c.us';

export interface Harness {
  repo: MemoryRepository;
  chat: ScriptedChat;
  embeddings: FakeEmbeddings;
  storage: MemoryStorage;
  router: TransportRouter;
  transports: Partial<Record<Channel, FakeTransport>>;
  transport: FakeTransport;
  flow: WhatsAppFlow;
}

export function harness(options?: { voice?: VoiceTranscriber; channels?: Channel[] }): Harness {
  const repo = new MemoryRepository();
  const chat = new ScriptedChat();
  const embeddings = new FakeEmbeddings();
  const storage = new MemoryStorage();
  const router = new TransportRouter();
  const channels = options?.channels ?? ['whatsapp'];
  const transports: Partial<Record<Channel, FakeTransport>> = {};
  for (const channel of channels) {
    const transport = new FakeTransport(channel);
    transports[channel] = transport;
    router.register(transport);
  }
  const flow = new WhatsAppFlow(
    router,
    repo,
    embeddings as unknown as EmbeddingClient,
    storage,
    chat as unknown as OpenRouterChat,
    'test-rerank',
    options?.voice,
  );
  const transport = transports[channels[0]!];
  if (!transport) throw new Error('harness needs at least one channel');
  return { repo, chat, embeddings, storage, router, transports, transport, flow };
}

export function textMsg(text: string, patch: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: randomUUID(),
    channel: 'whatsapp',
    chatId: CHAT,
    from: CHAT,
    type: 'text',
    text,
    timestamp: 1_700_000_000,
    fromMe: false,
    raw: {},
    ...patch,
  };
}

export function imageMsg(patch: Partial<IncomingMessage> = {}): IncomingMessage {
  return textMsg('', {
    type: 'image',
    text: undefined,
    media: { url: 'https://cdn.example/card.jpg', mimeType: 'image/jpeg' },
    ...patch,
  });
}

export function audioMsg(patch: Partial<IncomingMessage> = {}): IncomingMessage {
  return textMsg('', {
    type: 'audio',
    text: undefined,
    media: { url: 'https://cdn.example/note.ogg', mimeType: 'audio/ogg' },
    ...patch,
  });
}
