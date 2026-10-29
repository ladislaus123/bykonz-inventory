-- 001_init.sql
-- Schema from the "data models" whiteboard: users, entities, entity_media, jobs.
-- Requires the pgvector extension. Embedding size is 1536; change VECTOR(1536) to match your model.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector

-- Users
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    contact     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entities (one user creates many entities)
CREATE TABLE entities (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   TEXT NOT NULL,
    description            TEXT,
    description_embedding  VECTOR(1536),
    metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    modified_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entities_created_by  ON entities (created_by);
CREATE INDEX idx_entities_metadata    ON entities USING GIN (metadata);
CREATE INDEX idx_entities_description ON entities
    USING GIN (to_tsvector('english', coalesce(description, '')));
CREATE INDEX idx_entities_desc_embedding ON entities
    USING hnsw (description_embedding vector_cosine_ops);

-- Entity media (one entity has many media items)
CREATE TABLE entity_media (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    embedding    VECTOR(1536),
    storage_url  TEXT NOT NULL,  -- S3 link
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entity_media_entity_id ON entity_media (entity_id);
CREATE INDEX idx_entity_media_embedding ON entity_media
    USING hnsw (embedding vector_cosine_ops);

-- Jobs
CREATE TYPE job_type AS ENUM (
    'send_message',
    'embed_entity',
    'save_to_database',
    'agent_internet_search'
);

CREATE TABLE jobs (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_id        UUID REFERENCES entities(id) ON DELETE SET NULL,
    entity_media_id  UUID REFERENCES entity_media(id) ON DELETE SET NULL,
    job              job_type NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ
);

CREATE INDEX idx_jobs_user_id   ON jobs (user_id);
CREATE INDEX idx_jobs_entity_id ON jobs (entity_id);
CREATE INDEX idx_jobs_pending   ON jobs (created_at) WHERE completed_at IS NULL;

-- Keep modified_at / updated_at current
CREATE OR REPLACE FUNCTION touch_modified_at() RETURNS trigger AS $$
BEGIN NEW.modified_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entities_modified BEFORE UPDATE ON entities
    FOR EACH ROW EXECUTE FUNCTION touch_modified_at();
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

-- Rollback (run manually if needed):
-- BEGIN;
-- DROP TABLE IF EXISTS jobs, entity_media, entities, users;
-- DROP TYPE IF EXISTS job_type;
-- DROP FUNCTION IF EXISTS touch_modified_at(), touch_updated_at();
-- COMMIT;
