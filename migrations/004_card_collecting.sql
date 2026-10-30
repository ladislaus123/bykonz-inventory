-- 004_card_collecting.sql
-- Additive migration on top of 003_conversation_state.sql.
--
-- Adds a `card_collecting` conversation state so the business-card flow can
-- gather MORE THAN ONE photo of the same card (e.g. front + back) before the
-- enrichment agent runs. Sending the extra photo is OPTIONAL: the user may send
-- a single photo and process immediately as before.
--
-- Flow (driven by src/flow.ts):
--   idle/menu        --photo-->   card_collecting   (draft entity + 1st media)
--   card_collecting  --photo-->   card_collecting   (attach another photo)
--   card_collecting  --anything else / "Processar"--> (extract_card job) -> awaiting_decision
--
-- The extract_card job now carries all collected media ids in payload.mediaIds
-- and the agent reads every photo together.

BEGIN;

ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'card_collecting';

COMMIT;

-- Rollback (manual):
-- Enum values added to conversation_state ('card_collecting') cannot be dropped
-- in Postgres; leaving the value in place is harmless.
