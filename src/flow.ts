/**
 * WhatsAppFlow — orchestrates the conversation described in the brief:
 *
 *   text / "oi"      -> welcome (pt-BR) asking for a photo
 *   image            -> ack, persist media, enqueue background enrichment job
 *   (worker finishes)-> proposal message with Aceitar / Recusar buttons
 *   "1" / "aceitar"  -> confirm entity (status=confirmed) + embed + save
 *   "2" / "recusar"  -> reject entity (status=rejected)
 *
 * The heavy lifting (card OCR + web enrichment + embedding) runs OUT of band in
 * a worker that drains the `jobs` table; see runEnrichment() for the seam.
 */

import { createHash, randomUUID } from 'node:crypto';

import { ptBR } from './messages.pt-BR.js';
import type { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import type { Repository } from './repository/Repository.js';
import type { Storage } from './storage/Storage.js';
import type { IncomingMessage, MessageTransport } from './transport/MessageTransport.js';

export class WhatsAppFlow {
  constructor(
    private readonly transport: MessageTransport,
    private readonly repo: Repository,
    private readonly embeddings: EmbeddingClient,
    private readonly storage: Storage,
  ) {}

  /** Wire this as the transport's message handler. */
  handle = async (msg: IncomingMessage): Promise<void> => {
    const user = await this.repo.upsertUserByWaId(msg.from, {
      name: msg.from,
      contact: msg.from,
      waId: msg.from,
    });
    await this.repo.updateUser(user.id, { lastSeenAt: new Date().toISOString() });
    await this.transport.markSeen?.(msg);

    if (msg.type === 'image' || msg.type === 'document') {
      await this.onCardPhoto(msg, user.id);
      return;
    }

    if (msg.type === 'text') {
      const decision = parseDecision(msg.text ?? '');
      if (decision) {
        await this.onDecision(user.id, decision);
      } else if (isGreeting(msg.text ?? '')) {
        await this.transport.sendText(msg.chatId, ptBR.welcome);
      } else {
        await this.transport.sendText(msg.chatId, ptBR.notUnderstood);
      }
      return;
    }

    await this.transport.sendText(msg.chatId, ptBR.askForPhoto);
  };

  private async onCardPhoto(msg: IncomingMessage, userId: string): Promise<void> {
    await this.transport.sendText(msg.chatId, ptBR.received);
    await this.transport.sendTyping?.(msg.chatId, true);

    // Download bytes now (WAHA media URLs are short-lived) and hand to storage.
    const { data, mimeType } = await this.transport.downloadMedia(msg);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `cards/${userId}/${randomUUID()}.${extForMime(mimeType)}`;
    const storageKey = await this.storage.upload({ key, data, contentType: mimeType });

    // Create a draft entity + its media, then enqueue the background agent.
    const entity = await this.repo.createEntity({
      name: 'Novo cadastro',
      status: 'pending_review',
      source: 'business_card',
      createdBy: userId,
    });
    const media = await this.repo.createMedia({
      entityId: entity.id,
      storageUrl: storageKey, // object path; resolve to a signed URL on read
      mediaType: 'image',
      mimeType,
      sha256,
      waMessageId: msg.id,
    });
    await this.repo.enqueueJob({
      userId,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      waMessageId: msg.id,
      payload: { chatId: msg.chatId },
    });
    await this.transport.sendTyping?.(msg.chatId, false);
  }

  private async onDecision(userId: string, decision: 'accept' | 'reject'): Promise<void> {
    // Confirm/reject the most recent entity awaiting review for this user.
    const [pending] = await this.repo.listEntitiesByUser(userId, {
      status: 'pending_review',
      limit: 1,
    });
    const chatId = await this.chatIdFor(userId);
    if (!pending) {
      await this.transport.sendText(chatId, ptBR.notUnderstood);
      return;
    }

    if (decision === 'reject') {
      await this.repo.setEntityStatus(pending.id, 'rejected');
      await this.transport.sendText(chatId, ptBR.discarded);
      return;
    }

    await this.repo.setEntityStatus(pending.id, 'confirmed');
    // The agent normally embeds during enrichment; embed here only as a fallback.
    if (pending.description && !pending.descriptionEmbedding) {
      const vec = await this.embeddings.embedText(pending.description);
      await this.repo.setEntityEmbedding(pending.id, vec, this.embeddings.model);
    }
    await this.transport.sendText(chatId, ptBR.saved);
  }

  /**
   * Called by the worker once the agent has written + embedded the entity.
   * Just asks the user to confirm (the agent already persisted the data).
   */
  async presentProposal(
    chatId: string,
    _entityId: string,
    proposal: { name: string; summary: string },
  ): Promise<void> {
    await this.transport.sendButtons(chatId, ptBR.proposal(proposal), [
      { id: 'accept', title: ptBR.accept },
      { id: 'reject', title: ptBR.reject },
    ]);
  }

  // --- seams to implement per your infra -------------------------------------

  /** Resolve a user's chat id. For 1:1 WhatsApp, wa_id == chatId. */
  private async chatIdFor(userId: string): Promise<string> {
    const user = await this.repo.getUserById(userId);
    if (!user?.waId) throw new Error(`no wa_id for user ${userId}`);
    return user.waId;
  }
}

function extForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

function isGreeting(text: string): boolean {
  return /\b(oi|ol[áa]|bom dia|boa tarde|boa noite|come[çc]ar|start|menu)\b/i.test(text.trim());
}

function parseDecision(text: string): 'accept' | 'reject' | null {
  const t = text.trim().toLowerCase();
  if (/^(1|aceitar|aceito|sim|ok|confirmar?)/.test(t)) return 'accept';
  if (/^(2|recusar|recuso|n[ãa]o|cancelar)/.test(t)) return 'reject';
  return null;
}
