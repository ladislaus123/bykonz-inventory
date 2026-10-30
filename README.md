# Bykonz

WhatsApp bot that captures a **business card / brochure / pamphlet** photo, has an
agent enrich it from the web, and saves the business into an **embeddings database**
(Supabase Postgres + pgvector) for semantic search.

## Flows

The conversation is a **DB-backed state machine** (`conversation_states`, see
`003_conversation_state.sql`). One row per user holds their current `state` plus a
small JSONB `context` (e.g. the draft entity being built).

**1. Business card (default, state `idle`)**
```
user: 📷 card photo    -> ack + persist media + enqueue extract_card job
worker + agent         -> OCR card, web-enrich, propose summary
bot: proposal          -> "Encontrei isto … Posso salvar?"  [Aceitar] [Recusar]
user: Aceitar/Recusar  -> confirm (embed + save) OR reject
```

**2. Menu**
```
user: "oi"             -> menu:  1) Adicionar   2) Consultar
```

**3. Adicionar (`menu` → `add_collecting`)**
```
user: "1"              -> create draft entity, ask for text + optional photos
user: free text        -> enrich_text job: agent extracts/normalizes/saves -> proposal
user: 📷 image(s)       -> upload to S3 + embed_media job (image embedding stored)
bot: proposal          -> [Aceitar] [Recusar]  (confirms the draft)
```

**4. Consultar (`menu` → `consult_await`)**
```
user: "2"              -> ask for a natural-language query
user: "eletrônicos em Amsterdam"
                       -> embed query, cosine-search ALL confirmed businesses,
                          reply each match + its card/photos, back to idle
```

`"oi"` / `menu` from any state reopens the menu (escape hatch). Both the card and
Adicionar proposals funnel through the `awaiting_decision` state, so one handler
serves the Aceitar/Recusar step for both.

## Architecture (the four pieces you asked for)

| # | Deliverable | File |
|---|-------------|------|
| 1 | `MessageTransport` interface + WAHA impl | `src/transport/MessageTransport.ts`, `src/transport/WahaTransport.ts` |
| 2 | `Repository` interface (CRUD + search + jobs) + Supabase impl | `src/repository/Repository.ts`, `src/repository/SupabaseRepository.ts` |
| 3 | Schema additions (analysis of `001_init.sql`) | `002_enrich_schema.sql`, `003_conversation_state.sql` |
| 4 | Embedding client (gemini-embedding-2 via OpenRouter) | `src/embeddings/EmbeddingClient.ts` |

Everything depends on the **interfaces**, not the implementations, so WAHA can be
swapped for the official Cloud API and Supabase for any Postgres without touching
the flow.

## Embedding dimensions — the decision

- `google/gemini-embedding-2` on OpenRouter is **multimodal** (text + images in
  one vector space) and **defaults to 3072** dims.
- We pin output to **1536** (`EMBEDDING_DIMENSIONS=1536`, sent on every call):
  - pgvector's `hnsw`/`ivfflat` index supports only **≤2000 dims** for the native
    `vector` type — so `VECTOR(3072)` can't be indexed as-is.
  - 1536 matches 3072 on MTEB at **half the storage**.
- Because both text and media use the same model + dim, `entities.description_embedding`
  and `entity_media.embedding` are **directly comparable** (cross-modal search).
- To go to 3072 later: switch those columns to `halfvec(3072)` + `halfvec_cosine_ops`
  (halfvec indexes up to 4000 dims) and set `EMBEDDING_DIMENSIONS=3072`, then re-embed.

## Schema additions (`002_enrich_schema.sql`)

Additive migration on top of `001_init.sql`:

- **users**: `wa_id` (map WhatsApp sender), `locale` (pt-BR), `last_seen_at`.
- **entities**: `status` (`pending_review`/`confirmed`/`rejected` — the accept/deny
  step), `source`, promoted card fields (`phone`/`email`/`website`/`address`/`category`),
  `confidence`, `enrichment` JSONB (web-found data), `embedding_model`/`embedding_dim`,
  `confirmed_at`.
- **entity_media**: `media_type`, `mime_type`, `sha256` (dedupe), `caption`,
  `wa_message_id`, `width`/`height`, `embedding_model`.
- **jobs**: real worker-queue lifecycle — `status`, `payload`, `result`, `error`,
  `attempts`/`max_attempts`, `scheduled_at`, `wa_message_id`.
- **RPCs**: `match_entities(...)`, `match_entity_media(...)` for cosine search.

## State machine (`003_conversation_state.sql`)

- **conversation_states**: one row per user — `state` (`conversation_state` enum:
  `idle`/`menu`/`add_collecting`/`consult_await`/`awaiting_decision`), `context` JSONB,
  `updated_at`. Read/written via `repo.getConversationState` / `setConversationState`.
- New **job_type** values: `enrich_text` (free-text → agent) and `embed_media`
  (uploaded business image → pgvector embedding).

## Setup

```bash
cp .env.example .env    # fill in Supabase, OpenRouter, WAHA
# apply SQL in your Supabase SQL editor / psql, in order:
#   001_init.sql  then  002_enrich_schema.sql  then  003_conversation_state.sql
npm install
npm run dev             # starts the webhook server
```

Point WAHA's webhook at `POST http://<host>:<PORT>/webhook/waha`.

## Notes / caveats

- `EmbeddingClient.embedImage()` multimodal content-part shape — verify against
  your OpenRouter routing (the text path is the stable one). `embed_media` jobs
  retry on failure, so a routing hiccup won't lose the upload.
- Consultar searches **all** confirmed businesses (shared directory). To make it
  per-user, pass `filterUser` in `WhatsAppFlow.onConsultQuery`'s `searchEntities` call.
