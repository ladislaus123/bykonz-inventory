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
import { OpenRouterChat, type ChatMessage, type ToolDef } from './OpenRouterChat.js';

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

const SYSTEM_PROMPT = `Você é um assistente que cadastra empresas a partir de fotos de cartões de visita, folhetos e panfletos.
Fluxo obrigatório:
1. Analise a imagem e extraia o máximo de informação (nome, telefone, e-mail, site, endereço, segmento).
2. Use a ferramenta search_web para confirmar e enriquecer os dados na internet quando útil.
3. Chame save_business UMA vez com os dados consolidados. O campo description deve ser um parágrafo rico em português, pois será usado para busca semântica.
4. Chame finish com um resumo curto em português para o usuário confirmar.
Nunca invente dados que não consiga verificar; indique incerteza na confidence. Responda apenas usando as ferramentas.`;

export class EnrichmentAgent {
  constructor(
    private readonly chat: OpenRouterChat,
    private readonly repo: Repository,
    private readonly embeddings: EmbeddingClient,
    private readonly cfg: AgentConfig,
  ) {}

  async run(input: { entityId: string; imageUrl: string }): Promise<AgentResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Cadastre o negócio desta imagem. Siga o fluxo com as ferramentas.' },
          { type: 'image_url', image_url: { url: input.imageUrl } },
        ],
      },
    ];

    let result: AgentResult | null = null;

    log('agent', `run start entity=${input.entityId} model=${this.cfg.model}`);
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
