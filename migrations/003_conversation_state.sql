-- 003_conversation_state.sql
-- Additive migration on top of 001_init.sql + 002_enrich_schema.sql.
--
-- Adds a DB-controlled conversation state machine so the WhatsApp flow can be
-- multi-step (menu -> Adicionar / Consultar) instead of stateless. One row per
-- user holds WHERE that user is in the conversation plus a small JSONB context
-- (e.g. the draft entity id being built, the chat id to reply to).
--
-- State transitions (driven by src/flow.ts):
--   idle              --"oi"/menu-->            menu
--   menu              --"1"/adicionar-->        add_collecting   (draft entity created)
--   menu              --"2"/consultar-->        consult_await
--   add_collecting    --free text-->            (enrich_text job) -> awaiting_decision
--   add_collecting    --image-->                (embed_media job, stays add_collecting)
--   consult_await     --query text-->           idle (results sent inline)
--   awaiting_decision --"1"/aceitar-->          idle (entity confirmed + embedded)
--   awaiting_decision --"2"/recusar-->          idle (entity rejected)
-- "oi"/menu from any state resets to menu (escape hatch).
--
-- The business-card flow (001/002) also funnels its Aceitar/Recusar step through
-- awaiting_decision, so a single decision handler serves both card and text adds.

BEGIN;

-- New job kinds for the Adicionar flow:
--   enrich_text  -> agent extracts/normalizes a free-text business description
--   embed_media  -> embed an uploaded business image into pgvector
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'enrich_text';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'embed_media';

-- ---------------------------------------------------------------------------
-- Conversation state machine
-- ---------------------------------------------------------------------------
CREATE TYPE conversation_state AS ENUM (
    'idle',
    'menu',
    'add_collecting',
    'consult_await',
    'awaiting_decision'
);

CREATE TABLE conversation_states (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state       conversation_state NOT NULL DEFAULT 'idle',
    context     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"entityId": "...", "chatId": "..."}
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_states_state ON conversation_states (state);

-- Reuse the shared touch_updated_at() trigger function from 001_init.sql.
CREATE TRIGGER trg_conversation_states_updated BEFORE UPDATE ON conversation_states
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

-- Rollback (manual):
-- BEGIN;
-- DROP TABLE IF EXISTS conversation_states;
-- DROP TYPE IF EXISTS conversation_state;
-- -- Note: enum values added to job_type ('enrich_text','embed_media') cannot be
-- -- dropped in Postgres; leaving them is harmless.
-- COMMIT;
