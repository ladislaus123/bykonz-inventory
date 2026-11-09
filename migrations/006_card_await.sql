-- 006_card_await.sql
-- Additive migration on top of 003_conversation_state.sql / 004_card_collecting.sql.
--
-- Adds a `card_await` conversation state for the explicit "Adicionar cartão"
-- menu option (menu choice 4). After the user picks it, the flow parks them in
-- `card_await` and the NEXT photo they send enters the same card pipeline as a
-- photo dropped at idle (onCardPhoto -> card_collecting -> extract_card).
--
-- Flow (driven by src/flow.ts):
--   menu        --"4" / "cartão"-->   card_await      (prompt for the card photo)
--   card_await  --photo---------->    card_collecting (draft entity + 1st media)
--
-- Without this value, setConversationState(..., 'card_await') fails with
-- "22P02 invalid input value for enum conversation_state: card_await".

BEGIN;

ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'card_await';

COMMIT;

-- Rollback (manual):
-- Enum values added to conversation_state ('card_await') cannot be dropped
-- in Postgres; leaving the value in place is harmless.
