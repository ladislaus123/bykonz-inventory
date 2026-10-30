/**
 * WhatsAppFlow — a DB-backed state machine driving the conversation.
 *
 * States live in the `conversation_states` table (003_conversation_state.sql);
 * each inbound message is routed by the user's current state:
 *
 *   idle              photo             -> business-card flow 1 (extract_card job)
 *   idle              "oi" / menu       -> show menu, state=menu
 *   menu              "1" / adicionar   -> create draft, state=add_collecting
 *   menu              "2" / consultar   -> state=consult_await
 *   add_collecting    text              -> enrich_text job -> proposal
 *   add_collecting    image             -> upload + embed_media job (stays here)
 *   consult_await     text              -> embedding search, send results, state=idle
 *   awaiting_decision "1"/"2"           -> confirm / reject the proposed entity
 *
 * "oi" / menu from any state resets to the menu (escape hatch).
 *
 * Heavy lifting (OCR / web enrichment / embedding) runs out of band in the
 * worker that drains the `jobs` table; this class only enqueues and messages.
 */

import { createHash, randomUUID } from 'node:crypto';

import { log, logErr } from './log.js';
import { ptBR } from './messages.pt-BR.js';
import type { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import type { Repository } from './repository/Repository.js';
import type { Storage } from './storage/Storage.js';
import type { IncomingMessage, MessageTransport } from './transport/MessageTransport.js';

/** How many businesses (and images each) a Consultar reply shows. */
const CONSULT_MAX_RESULTS = 3;
const CONSULT_MAX_MEDIA = 3;
const CONSULT_MIN_SIMILARITY = 0.2;

export class WhatsAppFlow {
  constructor(
    private readonly transport: MessageTransport,
    private readonly repo: Repository,
    private readonly embeddings: EmbeddingClient,
    private readonly storage: Storage,
  ) {}

  /** Wire this as the transport's message handler. */
  handle = async (msg: IncomingMessage): Promise<void> => {
    try {
      log('flow', `handle message id=${msg.id} from=${msg.from} type=${msg.type}`);
      const user = await this.repo.upsertUserByWaId(msg.from, {
        name: msg.from,
        contact: msg.from,
        waId: msg.from,
      });
      await this.repo.updateUser(user.id, { lastSeenAt: new Date().toISOString() });
      await this.transport.markSeen?.(msg);

      const text = (msg.text ?? '').trim();
      const hasDownloadableMedia = Boolean(msg.media?.url || msg.media?.base64);
      const mediaSignalled =
        msg.type === 'image' ||
        msg.type === 'document' ||
        msg.type === 'video' ||
        msg.type === 'audio' ||
        msg.type === 'other' ||
        Boolean(msg.media);

      // Media was announced but we can't fetch the bytes (WAHA media download off).
      if (mediaSignalled && !hasDownloadableMedia) {
        logErr('flow', `media present but not downloadable (type=${msg.type}); check WAHA media config`);
        await this.transport.sendText(msg.chatId, ptBR.askForPhoto);
        return;
      }

      // Global escape hatch: a greeting always opens the menu.
      if (!hasDownloadableMedia && msg.type === 'text' && isGreeting(text)) {
        log('flow', 'greeting -> menu');
        await this.showMenu(user.id, msg.chatId);
        return;
      }

      const state = await this.repo.getConversationState(user.id);
      log('flow', `state=${state.state} hasMedia=${hasDownloadableMedia}`);

      switch (state.state) {
        case 'menu':
          if (hasDownloadableMedia) await this.onCardPhoto(msg, user.id);
          else await this.onMenuChoice(user.id, msg.chatId, text);
          return;

        case 'add_collecting':
          if (hasDownloadableMedia) await this.onAddMedia(msg, user.id, state.context);
          else await this.onAddText(user.id, msg.chatId, text, state.context);
          return;

        case 'consult_await':
          if (hasDownloadableMedia) {
            await this.transport.sendText(msg.chatId, ptBR.consultPrompt);
          } else {
            await this.onConsultQuery(user.id, msg.chatId, text);
          }
          return;

        case 'awaiting_decision': {
          const decision = parseDecision(text);
          if (decision) {
            await this.onDecision(user.id, msg.chatId, decision, state.context);
          } else if (hasDownloadableMedia) {
            // New card while a proposal was pending: start a fresh capture.
            await this.onCardPhoto(msg, user.id);
          } else {
            await this.transport.sendText(msg.chatId, ptBR.notUnderstood);
          }
          return;
        }

        case 'idle':
        default:
          if (hasDownloadableMedia) {
            await this.onCardPhoto(msg, user.id);
          } else {
            await this.transport.sendText(msg.chatId, ptBR.idleHint);
          }
          return;
      }
    } catch (err) {
      logErr('flow', `handle failed for message ${msg.id}`, err);
      await this.transport
        .sendText(msg.chatId, 'Ops, tive um problema ao processar sua mensagem. Tente novamente.')
        .catch(() => undefined);
    }
  };

  /* ===================== menu ===================== */

  private async showMenu(userId: string, chatId: string): Promise<void> {
    await this.repo.setConversationState(userId, 'menu', {});
    await this.transport.sendText(chatId, ptBR.menu);
  }

  private async onMenuChoice(userId: string, chatId: string, text: string): Promise<void> {
    const choice = parseMenuChoice(text);
    if (choice === 'add') {
      await this.enterAdicionar(userId, chatId);
    } else if (choice === 'consult') {
      await this.repo.setConversationState(userId, 'consult_await', {});
      await this.transport.sendText(chatId, ptBR.consultPrompt);
    } else {
      await this.transport.sendText(chatId, ptBR.menuNotUnderstood);
    }
  }

  /* ===================== Adicionar ===================== */

  private async enterAdicionar(userId: string, chatId: string): Promise<void> {
    // Seed a draft entity that both the free text and any images attach to.
    const entity = await this.repo.createEntity({
      name: 'Novo cadastro',
      status: 'pending_review',
      source: 'manual',
      createdBy: userId,
    });
    log('flow', `adicionar: draft entity ${entity.id} created for user ${userId}`);
    await this.repo.setConversationState(userId, 'add_collecting', { entityId: entity.id, chatId });
    await this.transport.sendText(chatId, ptBR.addPrompt);
  }

  private async onAddText(
    userId: string,
    chatId: string,
    text: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const entityId = typeof context.entityId === 'string' ? context.entityId : null;
    if (!entityId) {
      // Context lost somehow — restart the Adicionar flow cleanly.
      await this.enterAdicionar(userId, chatId);
      return;
    }
    if (!text || isFinishWord(text)) {
      await this.transport.sendText(chatId, ptBR.addNeedDescription);
      return;
    }

    await this.transport.sendText(chatId, ptBR.addAnalyzing);
    await this.transport.sendTyping?.(chatId, true);
    const job = await this.repo.enqueueJob({
      userId,
      job: 'enrich_text',
      entityId,
      payload: { chatId, text },
    });
    log('flow', `adicionar: enrich_text job ${job.id} enqueued for entity ${entityId}`);
    await this.transport.sendTyping?.(chatId, false);
  }

  private async onAddMedia(
    msg: IncomingMessage,
    userId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const entityId = typeof context.entityId === 'string' ? context.entityId : null;
    if (!entityId) {
      await this.enterAdicionar(userId, msg.chatId);
      return;
    }

    const { data, mimeType } = await this.transport.downloadMedia(msg);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `business/${userId}/${randomUUID()}.${extForMime(mimeType)}`;
    const storageKey = await this.storage.upload({ key, data, contentType: mimeType });
    log('flow', `adicionar: media uploaded key=${storageKey} for entity ${entityId}`);

    const media = await this.repo.createMedia({
      entityId,
      storageUrl: storageKey,
      mediaType: mimeType === 'application/pdf' ? 'document' : 'image',
      mimeType,
      sha256,
      waMessageId: msg.id,
    });

    await this.repo.enqueueJob({
      userId,
      job: 'embed_media',
      entityId,
      entityMediaId: media.id,
      payload: { chatId: msg.chatId },
    });
    log('flow', `adicionar: embed_media job enqueued for media ${media.id}`);
    await this.transport.sendText(msg.chatId, ptBR.addMediaReceived);
  }

  /* ===================== Consultar ===================== */

  private async onConsultQuery(userId: string, chatId: string, query: string): Promise<void> {
    if (!query) {
      await this.transport.sendText(chatId, ptBR.consultPrompt);
      return;
    }
    await this.transport.sendText(chatId, ptBR.consultSearching);
    await this.transport.sendTyping?.(chatId, true);

    // Search runs across ALL confirmed businesses (shared directory), not just
    // this user's own entries.
    const vec = await this.embeddings.embedText(query);
    const matches = await this.repo.searchEntities(vec, {
      status: 'confirmed',
      matchCount: CONSULT_MAX_RESULTS,
      similarityThreshold: CONSULT_MIN_SIMILARITY,
    });
    log('flow', `consultar: query="${query}" -> ${matches.length} match(es)`);

    // Back to idle regardless of outcome; a new "oi" reopens the menu.
    await this.repo.setConversationState(userId, 'idle', {});
    await this.transport.sendTyping?.(chatId, false);

    if (matches.length === 0) {
      await this.transport.sendText(chatId, ptBR.consultNoResults);
      return;
    }

    await this.transport.sendText(chatId, ptBR.consultHeader(matches.length));
    for (const match of matches) {
      const entity = await this.repo.getEntityById(match.id);
      if (!entity) continue;
      await this.transport.sendText(
        chatId,
        ptBR.consultResult({
          name: entity.name,
          category: entity.category,
          description: entity.description,
          phone: entity.phone,
          email: entity.email,
          website: entity.website,
          address: entity.address,
          similarity: match.similarity,
        }),
      );
      await this.sendEntityMedia(chatId, entity.id, entity.name);
    }
  }

  /** Send up to CONSULT_MAX_MEDIA images (card/photos) for a matched entity. */
  private async sendEntityMedia(chatId: string, entityId: string, caption: string): Promise<void> {
    const media = await this.repo.listMediaByEntity(entityId);
    const images = media.filter((m) => m.mediaType === 'image').slice(0, CONSULT_MAX_MEDIA);
    for (const item of images) {
      try {
        const url = await this.storage.getSignedUrl(item.storageUrl, 600);
        await this.transport.sendImage(chatId, {
          url,
          mimeType: item.mimeType ?? 'image/jpeg',
          caption,
        });
      } catch (err) {
        logErr('flow', `consultar: failed to send media ${item.id}`, err);
      }
    }
  }

  /* ===================== decision (shared by card + text adds) ===================== */

  private async onDecision(
    userId: string,
    chatId: string,
    decision: 'accept' | 'reject',
    context: Record<string, unknown>,
  ): Promise<void> {
    let entityId = typeof context.entityId === 'string' ? context.entityId : null;
    if (!entityId) {
      // Backward-compat: fall back to the most recent entity awaiting review.
      const [pending] = await this.repo.listEntitiesByUser(userId, {
        status: 'pending_review',
        limit: 1,
      });
      entityId = pending?.id ?? null;
    }

    await this.repo.setConversationState(userId, 'idle', {});

    if (!entityId) {
      await this.transport.sendText(chatId, ptBR.notUnderstood);
      return;
    }

    if (decision === 'reject') {
      await this.repo.setEntityStatus(entityId, 'rejected');
      await this.transport.sendText(chatId, ptBR.discarded);
      return;
    }

    const entity = await this.repo.setEntityStatus(entityId, 'confirmed');
    // The agent normally embeds during enrichment; embed here only as a fallback.
    if (entity.description && !entity.descriptionEmbedding) {
      const vec = await this.embeddings.embedText(entity.description);
      await this.repo.setEntityEmbedding(entity.id, vec, this.embeddings.model);
    }
    await this.transport.sendText(chatId, ptBR.saved);
  }

  /* ===================== business-card flow 1 ===================== */

  private async onCardPhoto(msg: IncomingMessage, userId: string): Promise<void> {
    log('flow', `onCardPhoto start msg=${msg.id} mediaUrl=${msg.media?.url ?? '(none)'}`);
    await this.transport.sendText(msg.chatId, ptBR.received);
    await this.transport.sendTyping?.(msg.chatId, true);

    // Download bytes now (WAHA media URLs are short-lived) and hand to storage.
    const { data, mimeType } = await this.transport.downloadMedia(msg);
    log('flow', `media downloaded ${data.length} bytes mime=${mimeType}`);

    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `cards/${userId}/${randomUUID()}.${extForMime(mimeType)}`;
    const storageKey = await this.storage.upload({ key, data, contentType: mimeType });
    log('flow', `media uploaded key=${storageKey}`);

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

    const job = await this.repo.enqueueJob({
      userId,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      waMessageId: msg.id,
      payload: { chatId: msg.chatId },
    });
    log('flow', `job enqueued id=${job.id} -> worker will pick it up`);
    await this.transport.sendTyping?.(msg.chatId, false);
  }

  /**
   * Called by the worker once the agent has written + embedded the entity.
   * Parks the user in `awaiting_decision` so their next 1/2 confirms this entity.
   */
  async presentProposal(
    userId: string,
    chatId: string,
    entityId: string,
    proposal: { name: string; summary: string },
  ): Promise<void> {
    await this.repo.setConversationState(userId, 'awaiting_decision', { entityId });
    await this.transport.sendButtons(chatId, ptBR.proposal(proposal), [
      { id: 'accept', title: ptBR.accept },
      { id: 'reject', title: ptBR.reject },
    ]);
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

/** Finish words that shouldn't be mistaken for a business description. */
function isFinishWord(text: string): boolean {
  return /^(pronto|finalizar|concluir|terminar|fim|ok)$/i.test(text.trim());
}

function parseMenuChoice(text: string): 'add' | 'consult' | null {
  const t = text.trim().toLowerCase();
  if (/^(1|adicionar|add|cadastrar)\b/.test(t)) return 'add';
  if (/^(2|consultar|buscar|procurar|pesquisar)\b/.test(t)) return 'consult';
  return null;
}

function parseDecision(text: string): 'accept' | 'reject' | null {
  const t = text.trim().toLowerCase();
  if (/^(1|aceitar|aceito|sim|ok|confirmar?)/.test(t)) return 'accept';
  if (/^(2|recusar|recuso|n[ãa]o|cancelar)/.test(t)) return 'reject';
  return null;
}
