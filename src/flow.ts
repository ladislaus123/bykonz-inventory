/**
 * WhatsAppFlow — a DB-backed state machine driving the conversation.
 *
 * Despite the name it is transport-agnostic and runs every configured channel
 * (WhatsApp via WAHA and/or Telegram) at the same time: each inbound message
 * carries its `channel`, and every reply is sent back out on the SAME channel
 * via the TransportRouter. A user chatting on Telegram is driven through
 * Telegram; a user on WhatsApp through WhatsApp — independently.
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
 * Heavy lifting (OCR / web enrichment / embedding) runs out of band in the
 * worker that drains the `jobs` table; this class only enqueues and messages.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { OpenRouterChat } from './agent/OpenRouterChat.js';
import { log, logErr } from './log.js';
import { ptBR } from './messages.pt-BR.js';
import type { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import type { Repository } from './repository/Repository.js';
import type { Storage } from './storage/Storage.js';
import type { EntityMatch } from './types/domain.js';
import type { Channel, IncomingMessage, MessageTransport } from './transport/MessageTransport.js';
import type { TransportRouter } from './transport/TransportRouter.js';

/** Consultar tuning. */
const CONSULT_MAX_RESULTS = 3; // businesses shown to the user
const CONSULT_MAX_MEDIA = 3; // images per business
const CONSULT_CANDIDATES = 8; // vector candidates fetched before reranking
const CONSULT_MIN_SIMILARITY = 0.25; // floor to drop obvious noise pre-rerank
// Fallback (rerank unavailable): keep only candidates within this cosine gap of
// the top hit, since similarity has a high, compressed baseline here.
const CONSULT_FALLBACK_GAP = 0.06;

export class WhatsAppFlow {
  constructor(
    private readonly transports: TransportRouter,
    private readonly repo: Repository,
    private readonly embeddings: EmbeddingClient,
    private readonly storage: Storage,
    private readonly chat: OpenRouterChat,
    private readonly rerankModel: string,
  ) {}

  /** Wire this as every transport's message handler. */
  handle = async (msg: IncomingMessage): Promise<void> => {
    const transport = this.transports.get(msg.channel);
    try {
      log('flow', `handle message id=${msg.id} channel=${msg.channel} from=${msg.from} type=${msg.type}`);
      const user = await this.repo.upsertUserByWaId(msg.from, {
        name: msg.from,
        contact: msg.from,
        waId: msg.from,
      });
      await this.repo.updateUser(user.id, { lastSeenAt: new Date().toISOString() });
      await transport.markSeen?.(msg);

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
        logErr('flow', `media present but not downloadable (type=${msg.type}); check transport media config`);
        await transport.sendText(msg.chatId, ptBR.askForPhoto);
        return;
      }

      // Global escape hatch: a greeting always opens the menu.
      if (!hasDownloadableMedia && msg.type === 'text' && isGreeting(text)) {
        log('flow', 'greeting -> menu');
        await this.showMenu(user.id, msg.chatId, transport);
        return;
      }

      const state = await this.repo.getConversationState(user.id);
      log('flow', `state=${state.state} hasMedia=${hasDownloadableMedia}`);

      switch (state.state) {
        case 'menu':
          if (hasDownloadableMedia) await this.onCardPhoto(msg, user.id, transport);
          else await this.onMenuChoice(user.id, msg.chatId, text, transport);
          return;

        case 'add_collecting':
          if (hasDownloadableMedia) await this.onAddMedia(msg, user.id, state.context, transport);
          else await this.onAddText(user.id, msg.chatId, text, state.context, transport);
          return;

        case 'consult_await':
          if (hasDownloadableMedia) {
            await transport.sendText(msg.chatId, ptBR.consultPrompt);
          } else {
            await this.onConsultQuery(user.id, msg.chatId, text, transport);
          }
          return;

        case 'awaiting_decision': {
          const decision = parseDecision(text);
          if (decision) {
            await this.onDecision(user.id, msg.chatId, decision, state.context, transport);
          } else if (hasDownloadableMedia) {
            // New card while a proposal was pending: start a fresh capture.
            await this.onCardPhoto(msg, user.id, transport);
          } else {
            await transport.sendText(msg.chatId, ptBR.notUnderstood);
          }
          return;
        }

        case 'idle':
        default:
          if (hasDownloadableMedia) {
            await this.onCardPhoto(msg, user.id, transport);
          } else {
            await transport.sendText(msg.chatId, ptBR.idleHint);
          }
          return;
      }
    } catch (err) {
      logErr('flow', `handle failed for message ${msg.id}`, err);
      await transport
        .sendText(msg.chatId, 'Ops, tive um problema ao processar sua mensagem. Tente novamente.')
        .catch(() => undefined);
    }
  };

  /* ===================== menu ===================== */

  private async showMenu(userId: string, chatId: string, transport: MessageTransport): Promise<void> {
    await this.repo.setConversationState(userId, 'menu', {});
    await transport.sendText(chatId, ptBR.menu);
  }

  private async onMenuChoice(
    userId: string,
    chatId: string,
    text: string,
    transport: MessageTransport,
  ): Promise<void> {
    const choice = parseMenuChoice(text);
    if (choice === 'add') {
      await this.enterAdicionar(userId, chatId, transport);
    } else if (choice === 'consult') {
      await this.repo.setConversationState(userId, 'consult_await', {});
      await transport.sendText(chatId, ptBR.consultPrompt);
    } else {
      await transport.sendText(chatId, ptBR.menuNotUnderstood);
    }
  }

  /* ===================== Adicionar ===================== */

  private async enterAdicionar(userId: string, chatId: string, transport: MessageTransport): Promise<void> {
    // Seed a draft entity that both the free text and any images attach to.
    const entity = await this.repo.createEntity({
      name: 'Novo cadastro',
      status: 'pending_review',
      source: 'manual',
      createdBy: userId,
    });
    log('flow', `adicionar: draft entity ${entity.id} created for user ${userId}`);
    await this.repo.setConversationState(userId, 'add_collecting', { entityId: entity.id, chatId });
    await transport.sendText(chatId, ptBR.addPrompt);
  }

  private async onAddText(
    userId: string,
    chatId: string,
    text: string,
    context: Record<string, unknown>,
    transport: MessageTransport,
  ): Promise<void> {
    const entityId = typeof context.entityId === 'string' ? context.entityId : null;
    if (!entityId) {
      // Context lost somehow — restart the Adicionar flow cleanly.
      await this.enterAdicionar(userId, chatId, transport);
      return;
    }
    if (!text || isFinishWord(text)) {
      await transport.sendText(chatId, ptBR.addNeedDescription);
      return;
    }

    await transport.sendText(chatId, ptBR.addAnalyzing);
    await transport.sendTyping?.(chatId, true);
    const job = await this.repo.enqueueJob({
      userId,
      job: 'enrich_text',
      entityId,
      payload: { chatId, channel: transport.channel, text },
    });
    log('flow', `adicionar: enrich_text job ${job.id} enqueued for entity ${entityId}`);
    await transport.sendTyping?.(chatId, false);
  }

  private async onAddMedia(
    msg: IncomingMessage,
    userId: string,
    context: Record<string, unknown>,
    transport: MessageTransport,
  ): Promise<void> {
    const entityId = typeof context.entityId === 'string' ? context.entityId : null;
    if (!entityId) {
      await this.enterAdicionar(userId, msg.chatId, transport);
      return;
    }

    const { data, mimeType } = await transport.downloadMedia(msg);
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
      payload: { chatId: msg.chatId, channel: transport.channel },
    });
    log('flow', `adicionar: embed_media job enqueued for media ${media.id}`);
    await transport.sendText(msg.chatId, ptBR.addMediaReceived);
  }

  /* ===================== Consultar ===================== */

  private async onConsultQuery(
    userId: string,
    chatId: string,
    query: string,
    transport: MessageTransport,
  ): Promise<void> {
    if (!query) {
      await transport.sendText(chatId, ptBR.consultPrompt);
      return;
    }
    await transport.sendText(chatId, ptBR.consultSearching);
    await transport.sendTyping?.(chatId, true);

    // Search runs across ALL confirmed businesses (shared directory), not just
    // this user's own entries. Pull a wider candidate set, then rerank it down
    // to the ones that actually satisfy the query (embedding similarity alone
    // has a high baseline, so unrelated businesses still score 0.5+).
    const vec = await this.embeddings.embedText(query);
    const candidates = await this.repo.searchEntities(vec, {
      status: 'confirmed',
      matchCount: CONSULT_CANDIDATES,
      similarityThreshold: CONSULT_MIN_SIMILARITY,
    });
    const matches = (await this.rerankMatches(query, candidates)).slice(0, CONSULT_MAX_RESULTS);
    log('flow', `consultar: query="${query}" -> ${candidates.length} candidate(s) -> ${matches.length} match(es)`);

    // Back to idle regardless of outcome; a new "oi" reopens the menu.
    await this.repo.setConversationState(userId, 'idle', {});
    await transport.sendTyping?.(chatId, false);

    if (matches.length === 0) {
      await transport.sendText(chatId, ptBR.consultNoResults);
      return;
    }

    await transport.sendText(chatId, ptBR.consultHeader(matches.length));
    for (const match of matches) {
      const entity = await this.repo.getEntityById(match.id);
      if (!entity) continue;
      await transport.sendText(
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
      await this.sendEntityMedia(chatId, entity.id, entity.name, transport);
    }
  }

  /**
   * Rerank vector candidates with the LLM so only businesses that genuinely
   * satisfy the query survive (e.g. "restaurant" shouldn't return an offroad
   * shop just because its description scored 0.56). The model returns the
   * relevant candidate numbers, most relevant first; irrelevant ones are
   * dropped. Falls back to a relative-similarity gap if the call fails.
   */
  private async rerankMatches(query: string, candidates: EntityMatch[]): Promise<EntityMatch[]> {
    if (candidates.length <= 1) return candidates;

    const list = candidates
      .map((c, i) => {
        const desc = (c.description ?? '').replace(/\s+/g, ' ').slice(0, 300);
        return `${i + 1}. ${c.name}\n${desc}`;
      })
      .join('\n\n');

    try {
      const res = await this.chat.complete({
        model: this.rerankModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Você seleciona quais negócios atendem à busca do usuário. ' +
              'Responda APENAS com um array JSON com os números dos negócios realmente relevantes, ' +
              'do mais para o menos relevante (ex.: [2,1]). Se nenhum servir, responda [].',
          },
          { role: 'user', content: `Busca do usuário: "${query}"\n\nNegócios:\n${list}` },
        ],
      });

      const raw = typeof res.content === 'string' ? res.content : '';
      const picked = parseIndexArray(raw, candidates.length);
      if (picked === null) throw new Error('unparseable rerank response');
      return picked.map((n) => candidates[n - 1]!);
    } catch (err) {
      logErr('flow', 'consultar: rerank failed, falling back to similarity gap', err);
      const top = candidates[0]!.similarity;
      return candidates.filter((c) => c.similarity >= top - CONSULT_FALLBACK_GAP);
    }
  }

  /** Send up to CONSULT_MAX_MEDIA images (card/photos) for a matched entity. */
  private async sendEntityMedia(
    chatId: string,
    entityId: string,
    caption: string,
    transport: MessageTransport,
  ): Promise<void> {
    const media = await this.repo.listMediaByEntity(entityId);
    const images = media.filter((m) => m.mediaType === 'image').slice(0, CONSULT_MAX_MEDIA);
    for (const item of images) {
      try {
        const url = await this.storage.getSignedUrl(item.storageUrl, 600);
        await transport.sendImage(chatId, {
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
    transport: MessageTransport,
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
      await transport.sendText(chatId, ptBR.notUnderstood);
      return;
    }

    if (decision === 'reject') {
      await this.repo.setEntityStatus(entityId, 'rejected');
      await transport.sendText(chatId, ptBR.discarded);
      return;
    }

    const entity = await this.repo.setEntityStatus(entityId, 'confirmed');
    // The agent normally embeds during enrichment; embed here only as a fallback.
    if (entity.description && !entity.descriptionEmbedding) {
      const vec = await this.embeddings.embedText(entity.description);
      await this.repo.setEntityEmbedding(entity.id, vec, this.embeddings.model);
    }
    await transport.sendText(chatId, ptBR.saved);
  }

  /* ===================== business-card flow 1 ===================== */

  private async onCardPhoto(msg: IncomingMessage, userId: string, transport: MessageTransport): Promise<void> {
    log('flow', `onCardPhoto start msg=${msg.id} mediaUrl=${msg.media?.url ?? '(none)'}`);
    await transport.sendText(msg.chatId, ptBR.received);
    await transport.sendTyping?.(msg.chatId, true);

    // Download bytes now (provider media URLs are short-lived) and hand to storage.
    const { data, mimeType } = await transport.downloadMedia(msg);
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
      payload: { chatId: msg.chatId, channel: transport.channel },
    });
    log('flow', `job enqueued id=${job.id} -> worker will pick it up`);
    await transport.sendTyping?.(msg.chatId, false);
  }

  /**
   * Called by the worker once the agent has written + embedded the entity.
   * Parks the user in `awaiting_decision` and sends the proposal on `channel`
   * (the backend the originating message came in on).
   */
  async presentProposal(
    userId: string,
    chatId: string,
    channel: Channel,
    entityId: string,
    proposal: { name: string; summary: string },
  ): Promise<void> {
    await this.repo.setConversationState(userId, 'awaiting_decision', { entityId });
    await this.transports.get(channel).sendButtons(chatId, ptBR.proposal(proposal), [
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

/**
 * Parse the rerank model's reply into valid 1-based indices (deduped, in order).
 * Returns null if no JSON array is found (so the caller can fall back); an empty
 * array is a valid "nothing matched" answer.
 */
function parseIndexArray(text: string, max: number): number[] | null {
  const m = text.match(/\[[^\]]*\]/);
  if (!m) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of arr) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= max && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function parseDecision(text: string): 'accept' | 'reject' | null {
  const t = text.trim().toLowerCase();
  if (/^(1|aceitar|aceito|sim|ok|confirmar?)/.test(t)) return 'accept';
  if (/^(2|recusar|recuso|n[ãa]o|cancelar)/.test(t)) return 'reject';
  return null;
}
