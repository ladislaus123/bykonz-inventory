-- 002_enrich_schema.sql
-- Additive migration on top of 001_init.sql for the WhatsApp business-card flow.
--
-- Why these fields (analysis of 001):
--   * The flow needs to map an incoming WhatsApp message to a user  -> users.wa_id
--   * The user ACCEPTS or DENIES the proposed entity                -> entities.status
--   * The agent enriches the card with web data                     -> entities.enrichment
--     and we promote the few fields we actually filter/sort on      -> phone/email/website/...
--   * We must know which model/size produced a vector (re-embedding) -> embedding_model/dim
--   * jobs needs a real worker lifecycle (ret‏ries, errors, payload) -> status/payload/result...
--
-- Embedding size: we KEEP VECTOR(1536) from 001 on purpose.
--   google/gemini-embedding-2 defaults to 3072 but supports Matryoshka truncation.
--   pgvector's hnsw/ivfflat index only supports <=2000 dims for the native `vector`
--   type, and 1536 scores the same on MTEB as 3072. If you ever need 3072, switch the
--   columns to halfvec(3072) + halfvec_cosine_ops (halfvec indexes up to 4000 dims).

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE entity_status AS ENUM ('pending_review', 'confirmed', 'rejected');
CREATE TYPE media_type    AS ENUM ('image', 'document', 'audio', 'video');
CREATE TYPE job_status     AS ENUM ('pending', 'running', 'done', 'failed', 'canceled');

-- Extra job kinds for the card pipeline (ALTER TYPE ADD VALUE cannot run in some
-- txn contexts on older PG; these are safe on PG 12+).
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'extract_card';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'enrich_entity';

-- ---------------------------------------------------------------------------
-- users: identify the WhatsApp sender + locale for pt-BR messaging
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN wa_id        TEXT,                       -- WhatsApp JID, e.g. 5511999999999@c.us
    ADD COLUMN locale       TEXT NOT NULL DEFAULT 'pt-BR',
    ADD COLUMN last_seen_at TIMESTAMPTZ;

CREATE UNIQUE INDEX idx_users_wa_id ON users (wa_id) WHERE wa_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- entities: review lifecycle + promoted business-card fields + enrichment
-- ---------------------------------------------------------------------------
ALTER TABLE entities
    ADD COLUMN status          entity_status NOT NULL DEFAULT 'pending_review',
    ADD COLUMN source          TEXT,                    -- business_card | brochure | pamphlet
    ADD COLUMN phone           TEXT,
    ADD COLUMN email           TEXT,
    ADD COLUMN website         TEXT,
    ADD COLUMN address         TEXT,
    ADD COLUMN category        TEXT,                    -- industry / segment
    ADD COLUMN confidence      NUMERIC(4, 3),           -- extractor/agent confidence 0..1
    ADD COLUMN enrichment      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- raw web-found data
    ADD COLUMN embedding_model TEXT,
    ADD COLUMN embedding_dim   INTEGER,
    ADD COLUMN confirmed_at    TIMESTAMPTZ;

CREATE INDEX idx_entities_status     ON entities (status);
CREATE INDEX idx_entities_enrichment ON entities USING GIN (enrichment);

-- ---------------------------------------------------------------------------
-- entity_media: type/mime, dedupe hash, provenance back to the WA message
-- ---------------------------------------------------------------------------
ALTER TABLE entity_media
    ADD COLUMN media_type      media_type NOT NULL DEFAULT 'image',
    ADD COLUMN mime_type       TEXT,
    ADD COLUMN sha256          TEXT,                    -- dedupe identical uploads
    ADD COLUMN caption         TEXT,
    ADD COLUMN wa_message_id   TEXT,
    ADD COLUMN width           INTEGER,
    ADD COLUMN height          INTEGER,
    ADD COLUMN embedding_model TEXT;

CREATE INDEX idx_entity_media_sha256 ON entity_media (sha256) WHERE sha256 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- jobs: real worker-queue lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
    ADD COLUMN status        job_status NOT NULL DEFAULT 'pending',
    ADD COLUMN payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN result        JSONB,
    ADD COLUMN error         TEXT,
    ADD COLUMN attempts      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN max_attempts  INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN wa_message_id TEXT;

-- Replace the "pending" partial index to key off status + schedule time.
DROP INDEX IF EXISTS idx_jobs_pending;
CREATE INDEX idx_jobs_claimable ON jobs (scheduled_at)
    WHERE status = 'pending';

COMMIT;

-- ===========================================================================
-- Vector-search RPCs (called from the repository via supabase.rpc(...)).
-- Cosine similarity = 1 - (embedding <=> query).  VECTOR(1536) matches the
-- embedding model configured in .env (EMBEDDING_DIMENSIONS=1536).
-- ===========================================================================
BEGIN;

CREATE OR REPLACE FUNCTION match_entities(
    query_embedding      VECTOR(1536),
    match_count          INTEGER DEFAULT 10,
    similarity_threshold REAL    DEFAULT 0.0,
    filter_user          UUID    DEFAULT NULL,
    filter_status        entity_status DEFAULT NULL
)
RETURNS TABLE (
    id          UUID,
    name        TEXT,
    description TEXT,
    metadata    JSONB,
    status      entity_status,
    created_by  UUID,
    similarity  REAL
)
LANGUAGE sql STABLE AS $$
    SELECT e.id, e.name, e.description, e.metadata, e.status, e.created_by,
           (1 - (e.description_embedding <=> query_embedding))::real AS similarity
    FROM entities e
    WHERE e.description_embedding IS NOT NULL
      AND (filter_user   IS NULL OR e.created_by = filter_user)
      AND (filter_status IS NULL OR e.status = filter_status)
      AND (1 - (e.description_embedding <=> query_embedding)) >= similarity_threshold
    ORDER BY e.description_embedding <=> query_embedding
    LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_entity_media(
    query_embedding      VECTOR(1536),
    match_count          INTEGER DEFAULT 10,
    similarity_threshold REAL    DEFAULT 0.0,
    filter_user          UUID    DEFAULT NULL
)
RETURNS TABLE (
    id          UUID,
    entity_id   UUID,
    storage_url TEXT,
    media_type  media_type,
    similarity  REAL
)
LANGUAGE sql STABLE AS $$
    SELECT m.id, m.entity_id, m.storage_url, m.media_type,
           (1 - (m.embedding <=> query_embedding))::real AS similarity
    FROM entity_media m
    JOIN entities e ON e.id = m.entity_id
    WHERE m.embedding IS NOT NULL
      AND (filter_user IS NULL OR e.created_by = filter_user)
      AND (1 - (m.embedding <=> query_embedding)) >= similarity_threshold
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
$$;

COMMIT;

-- Rollback (manual):
-- BEGIN;
-- DROP FUNCTION IF EXISTS match_entities(vector, integer, real, uuid, entity_status);
-- DROP FUNCTION IF EXISTS match_entity_media(vector, integer, real, uuid);
-- ALTER TABLE jobs DROP COLUMN status, DROP COLUMN payload, DROP COLUMN result,
--   DROP COLUMN error, DROP COLUMN attempts, DROP COLUMN max_attempts,
--   DROP COLUMN scheduled_at, DROP COLUMN wa_message_id;
-- ALTER TABLE entity_media DROP COLUMN media_type, DROP COLUMN mime_type,
--   DROP COLUMN sha256, DROP COLUMN caption, DROP COLUMN wa_message_id,
--   DROP COLUMN width, DROP COLUMN height, DROP COLUMN embedding_model;
-- ALTER TABLE entities DROP COLUMN status, DROP COLUMN source, DROP COLUMN phone,
--   DROP COLUMN email, DROP COLUMN website, DROP COLUMN address, DROP COLUMN category,
--   DROP COLUMN confidence, DROP COLUMN enrichment, DROP COLUMN embedding_model,
--   DROP COLUMN embedding_dim, DROP COLUMN confirmed_at;
-- ALTER TABLE users DROP COLUMN wa_id, DROP COLUMN locale, DROP COLUMN last_seen_at;
-- DROP TYPE IF EXISTS entity_status, media_type, job_status;
-- COMMIT;
