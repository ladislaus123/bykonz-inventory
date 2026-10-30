/**
 * EnrichmentAgent — the autonomous agentic loop.
 *
 * Given a draft entity and a signed URL to its card/brochure image, it:
 *   1. Reads the image (vision) to extract the business's details.
 *   2. Optionally calls the `search_web` tool to enrich from the internet.
 *   3. Calls `save_business` to write name/description/metadata/fields to the
 *      entities table itself (autonomous persistence).
 *   4. Calls `finish` to end the loop with a short pt-BR summary for the user.
 * After the loop it embeds the saved description so future lookups are easy.
 *
 * The entity stays `pending_review`; the WhatsApp accept/deny step confirms it.
 */

import { log } from '../log.js';
import type { EmbeddingClient } from '../embeddings/EmbeddingClient.js';
import type { Repository } from '../repository/Repository.js';
import type { NewEntity } from '../types/domain.js';
import { OpenRouterChat, type ChatMessage, type ContentPart, type ToolDef } from './OpenRouterChat.js';

export interface AgentConfig {
  model: string; // vision + tool-calling model, e.g. google/gemini-2.5-flash
  searchModel: string; // model used for the web-search tool (with :online / web plugin)
  maxSteps: number;
  webMaxResults: number;
}

export interface AgentResult {
  name: string;
  summary: string;
}

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the public web for more information about the business (official site, ' +
        'social profiles, industry, services, address, hours). Use the business name plus ' +
        'any phone/city/domain read from the card to disambiguate.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_business',
      description:
        'Persist the extracted + enriched business into the database. Call this once you ' +
        'have gathered what you can. description must be a rich pt-BR paragraph used for ' +
        'semantic search. Put anything structured and extra into metadata.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'Rich pt-BR description for embedding.' },
          category: { type: 'string', description: 'Industry / segment.' },
          phone: { type: 'string' },
          email: { type: 'string' },
          website: { type: 'string' },
          address: { type: 'string' },
          confidence: { type: 'number', description: '0..1 confidence in the extraction.' },
          contacts: {
            type: 'array',
            description:
              'ALL contacts found (people, phones, e-mails, departments). Include every ' +
              'distinct contact — a card may list more than one. phone/email above are the ' +
              'primary/main contact; put every contact (including the primary) here too.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Contact person name, if any.' },
                role: { type: 'string', description: 'Job title / department.' },
                phone: { type: 'string' },
                email: { type: 'string' },
                label: { type: 'string', description: 'e.g. comercial, suporte, whatsapp.' },
              },
            },
          },
          metadata: {
            type: 'object',
            description: 'Any extra structured data (social links, hours, people, etc.).',
            additionalProperties: true,
          },
        },
        required: ['name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the task. Provide the business name and a short pt-BR summary (1-3 lines) to show the user for confirmation.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, summary: { type: 'string' } },
        required: ['name', 'summary'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Você é um assistente que cadastra empresas a partir de fotos de cartões de visita, folhetos e panfletos, OU a partir de descrições em texto enviadas pelo usuário.
Quando houver mais de uma imagem, elas podem ser a frente e o verso do mesmo cartão (ou fotos complementares do mesmo negócio): analise todas e combine as informações em um único cadastro.
Fluxo obrigatório:
1. Analise a entrada (imagem(ns) ou texto) e extraia/normalize o máximo de informação (nome, telefone, e-mail, site, endereço, segmento).
   Um negócio pode ter MAIS DE UM contato (várias pessoas, telefones, e-mails, departamentos): identifique TODOS e inclua-os no array contacts de save_business.
2. Use a ferramenta search_web para confirmar e enriquecer os dados na internet quando útil.
3. Chame save_business UMA vez com os dados consolidados e normalizados. O campo description deve ser um parágrafo rico em português, pois será usado para busca semântica.
4. Chame finish com um resumo curto em português para o usuário confirmar.
Nunca invente dados que não consiga verificar; indique incerteza na confidence. Responda apenas usando as ferramentas.`;

export class EnrichmentAgent {
  constructor(
    private readonly chat: OpenRouterChat,
    private readonly repo: Repository,
    private readonly embeddings: EmbeddingClient,
    private readonly cfg: AgentConfig,
  ) {}

  /**
   * Run the enrichment loop against either card/brochure image(s) (`imageUrl` or
   * `imageUrls` — e.g. the front and back of the same card) or a free-text
   * business description (`text`). At least one must be provided.
   */
  async run(input: {
    entityId: string;
    imageUrl?: string;
    imageUrls?: string[];
    text?: string;
  }): Promise<AgentResult> {
    const images = [...(input.imageUrls ?? []), ...(input.imageUrl ? [input.imageUrl] : [])];
    const userContent: ContentPart[] = [];
    if (images.length) {
      userContent.push({
        type: 'text',
        text:
          images.length > 1
            ? `Cadastre o negócio a partir destas ${images.length} imagens (podem ser frente e verso ` +
              'do mesmo cartão, ou fotos complementares — combine as informações). Siga o fluxo com as ferramentas.'
            : 'Cadastre o negócio desta imagem. Siga o fluxo com as ferramentas.',
      });
      for (const url of images) {
        userContent.push({ type: 'image_url', image_url: { url } });
      }
    } else if (input.text?.trim()) {
      userContent.push({
        type: 'text',
        text:
          'Cadastre o negócio a partir da descrição a seguir, enviada pelo usuário. ' +
          'Extraia e normalize os dados e siga o fluxo com as ferramentas.\n\n' +
          `Descrição do usuário:\n"""\n${input.text.trim()}\n"""`,
      });
    } else {
      throw new Error('EnrichmentAgent.run requires either imageUrl or text');
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    let result: AgentResult | null = null;

    log(
      'agent',
      `run start entity=${input.entityId} model=${this.cfg.model} input=${images.length ? `${images.length} image(s)` : 'text'}`,
    );
    for (let step = 0; step < this.cfg.maxSteps; step++) {
      const assistant = await this.chat.complete({
        model: this.cfg.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.2,
      });
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      log('agent', `step ${step}: ${calls.length} tool call(s) [${calls.map((c) => c.function.name).join(', ')}]`);
      if (calls.length === 0) break; // model stopped calling tools

      for (const call of calls) {
        const args = safeParse(call.function.arguments);
        let toolResult: string;

        switch (call.function.name) {
          case 'search_web':
            toolResult = await this.searchWeb(String(args.query ?? ''));
            break;
          case 'save_business':
            await this.saveBusiness(input.entityId, args);
            toolResult = 'ok: business saved';
            break;
          case 'finish':
            result = {
              name: String(args.name ?? 'Negócio'),
              summary: String(args.summary ?? ''),
            };
            toolResult = 'ok: finished';
            break;
          default:
            toolResult = `error: unknown tool ${call.function.name}`;
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
      }

      if (result) break;
    }

    // Safety net: if the model finished without saving, persist whatever we can
    // from the entity, and always embed the description for future lookup.
    const entity = await this.repo.getEntityById(input.entityId);
    if (!entity) throw new Error(`entity ${input.entityId} vanished`);

    if (entity.description && !entity.descriptionEmbedding) {
      log('agent', `embedding description for entity ${entity.id}`);
      const vec = await this.embeddings.embedText(entity.description);
      await this.repo.setEntityEmbedding(entity.id, vec, this.embeddings.model);
      log('agent', `embedding stored (${vec.length} dims)`);
    }

    return (
      result ?? {
        name: entity.name,
        summary: entity.description ?? 'Não consegui extrair detalhes suficientes.',
      }
    );
  }

  /** Web search via OpenRouter's built-in web plugin (uses only OPENROUTER_API_KEY). */
  private async searchWeb(query: string): Promise<string> {
    if (!query.trim()) return 'error: empty query';
    const msg = await this.chat.complete({
      model: this.cfg.searchModel,
      plugins: [{ id: 'web', max_results: this.cfg.webMaxResults }],
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a web research assistant. Search the web and return concise, factual ' +
            'findings with source URLs. If nothing relevant is found, say so.',
        },
        { role: 'user', content: query },
      ],
    });
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  }

  private async saveBusiness(entityId: string, args: Record<string, unknown>): Promise<void> {
    const patch: Partial<NewEntity> = {
      name: str(args.name),
      description: str(args.description),
      category: str(args.category),
      phone: str(args.phone),
      email: str(args.email),
      website: str(args.website),
      address: str(args.address),
      confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
      metadata: isRecord(args.metadata) ? args.metadata : undefined,
    };
    await this.repo.updateEntity(entityId, pruneUndefined(patch));

    // Persist additional contacts, if the model found any (a card may list more
    // than one). We skip a contact that merely repeats the entity's primary
    // phone/email with no extra information.
    const contacts = normalizeContacts(args.contacts);
    for (const c of contacts) {
      const isPrimaryDup =
        !c.name && !c.role && !c.label && c.phone === patch.phone && c.email === patch.email;
      if (isPrimaryDup) continue;
      await this.repo.createContact({ entityId, source: 'business_card', ...c });
    }
  }

  /**
   * Extract one or more contacts from a free-text (or voice-transcribed) message
   * the user sent to attach to an EXISTING business. Single LLM call, strict JSON
   * out — no tools, no web search. Returns [] when nothing contact-like is found.
   */
  async extractContacts(text: string): Promise<ContactInput[]> {
    if (!text.trim()) return [];
    const res = await this.chat.complete({
      model: this.cfg.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Extraia os contatos do texto do usuário (pessoas, telefones, e-mails, cargos, ' +
            'departamentos). Pode haver mais de um contato. Responda APENAS com um array JSON; ' +
            'cada item: {"name"?, "role"?, "phone"?, "email"?, "label"?}. Normalize telefones e ' +
            'e-mails. Se não houver nenhum contato, responda [].',
        },
        { role: 'user', content: text.trim() },
      ],
    });
    const raw = typeof res.content === 'string' ? res.content : '';
    return normalizeContacts(parseJsonArray(raw));
  }
}

/** A contact as accepted by the repository (minus entityId/source). */
export interface ContactInput {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
  label?: string;
}

/** Coerce arbitrary model output into clean ContactInput[] (drops empty ones). */
function normalizeContacts(value: unknown): ContactInput[] {
  if (!Array.isArray(value)) return [];
  const out: ContactInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const c: ContactInput = {
      name: str(item.name),
      role: str(item.role),
      phone: str(item.phone),
      email: str(item.email),
      label: str(item.label),
    };
    if (c.name || c.role || c.phone || c.email || c.label) out.push(c);
  }
  return out;
}

/** Pull the first JSON array out of a model reply; [] on failure. */
function parseJsonArray(text: string): unknown {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]);
  } catch {
    return [];
  }
}

/* helpers */
function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}
