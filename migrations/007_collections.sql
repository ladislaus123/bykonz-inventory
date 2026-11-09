-- 007_collections.sql
-- Additive migration on top of 006_card_await.sql.
--
-- COLLECTIONS: a named grouping for the business cards a user collects, by the
-- context where they got them — a fair, a trip, a client visit, a referral
-- batch. It is NOT limited to "events": a collection is any bucket the user
-- names and can annotate with notes/date/location.
--
-- Model: many-to-one. Each entity (one scanned card = one entity, no dedup) is
-- stamped with at most ONE collection — the user's ACTIVE collection at scan
-- time. A collection has many entities. If businesses are ever deduped so one
-- record spans several collections, this upgrades to a join table later
-- (create entity_collections, backfill from entities.collection_id, drop it).
--
-- Flow (driven by src/flow.ts):
--   menu            --"5" / "coleção"-->   collection_await   (ask for a name)
--   collection_await --name text-->        resolve-or-create collection,
--                                          set users.active_collection_id, -> menu
--   onCardPhoto / enterAdicionar           createEntity(collection_id = active)
--
-- The query side ("quais negócios peguei na Feira Rio 2022?") will reuse the
-- pg_trgm index below; this migration already enables it.

-- Enum value must be added in its own transaction (it isn't used until the app
-- runs, so this is safe), separate from the table DDL that follows.
BEGIN;
ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'collection_await';
COMMIT;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy name lookup for the future query flow

CREATE TABLE collections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    notes         TEXT,                 -- free-text notes about where/how collected
    collected_on  DATE,                 -- optional: when the cards were collected
    location      TEXT,                 -- optional: city / venue
    created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_collections_created_by ON collections (created_by);
-- Trigram index for fuzzy "which collection did the user mean?" lookups.
CREATE INDEX idx_collections_name_trgm  ON collections USING GIN (name gin_trgm_ops);
-- One collection name per owner (case-insensitive), so "resolve-or-create by
-- name" is idempotent and typing the same name twice reuses the collection.
CREATE UNIQUE INDEX idx_collections_owner_name ON collections (created_by, lower(name));

-- Each entity belongs to at most one collection.
ALTER TABLE entities
    ADD COLUMN collection_id UUID REFERENCES collections(id) ON DELETE SET NULL;
CREATE INDEX idx_entities_collection ON entities (collection_id);

-- The collection a user is currently scanning into; stamped onto new entities.
ALTER TABLE users
    ADD COLUMN active_collection_id UUID REFERENCES collections(id) ON DELETE SET NULL;

COMMIT;

-- Rollback (manual):
-- BEGIN;
-- ALTER TABLE users    DROP COLUMN IF EXISTS active_collection_id;
-- ALTER TABLE entities DROP COLUMN IF EXISTS collection_id;
-- DROP TABLE IF EXISTS collections;
-- -- enum value added to conversation_state ('collection_await') cannot be dropped
-- -- in Postgres; leaving it in place is harmless.
-- COMMIT;
