# Bykonz

WhatsApp bot that captures a **business card / brochure / pamphlet** photo, has an
agent enrich it from the web, and saves the business into an **embeddings database**
(Supabase Postgres + pgvector) for semantic search.

## Flow

```
user: "oi"            -> welcome (pt-BR): "envie uma foto do cartão…"
user: 📷 photo         -> ack + persist media + enqueue background job
worker + agent         -> OCR card, web-enrich, propose summary
bot: proposal          -> "Encontrei isto … Posso salvar?"  [Aceitar] [Recusar]
user: Aceitar/Recusar  -> confirm (embed + save) OR reject
```

## Architecture (the four pieces you asked for)

| # | Deliverable | File |
|---|-------------|------|
| 1 | `MessageTransport` interface + WAHA impl | `src/transport/MessageTransport.ts`, `src/transport/WahaTransport.ts` |
| 2 | `Repository` interface (CRUD + search + jobs) + Supabase impl | `src/repository/Repository.ts`, `src/repository/SupabaseRepository.ts` |
| 3 | Schema additions (analysis of `001_init.sql`) | `002_enrich_schema.sql` |
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

## Setup

```bash
cp .env.example .env    # fill in Supabase, OpenRouter, WAHA
# apply SQL in your Supabase SQL editor / psql:
#   001_init.sql  then  002_enrich_schema.sql
npm install
npm run dev             # starts the webhook server
```

Point WAHA's webhook at `POST http://<host>:<PORT>/webhook/waha`.

## Still to wire (marked in code)

- `flow.ts:uploadToStorage()` — push media bytes to Supabase Storage / S3.
- The **worker** that drains `jobs` (`repo.listPendingJobs`) and the **agent**
  (card OCR + web search) that calls `flow.presentProposal(...)`.
- `EmbeddingClient.embedImage()` multimodal content-part shape — verify against
  your OpenRouter routing (the text path is the stable one).
