-- 005_contacts_and_voice.sql
-- Additive migration on top of 004_card_collecting.sql.
--
-- 1) MULTIPLE CONTACTS PER BUSINESS
--    A business card (or a free-text description) can carry more than one
--    contact (several people, phones, e-mails, departments). The entity keeps
--    its single promoted phone/email/website/address as the "primary" contact;
--    any ADDITIONAL contacts live in the new entity_contacts table. The agent
--    extracts them from the card/text, and the user can add more later through
--    the "Adicionar contato" menu option.
--
-- 2) VOICE
--    No schema change is needed for voice: inbound audio is transcribed to text
--    (Deepgram) and then flows through the normal text paths.

BEGIN;

-- Job kind: extract contact(s) from free text / voice and append to a business.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'add_contact';

-- Conversation states for the "Adicionar contato" flow:
--   contact_find  -> user is describing WHICH business to attach a contact to
--   contact_await -> business chosen; waiting for the contact details (text/voice)
ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'contact_find';
ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'contact_await';

COMMIT;

-- entity_contacts must be created in a separate transaction from the ALTER TYPE
-- ADD VALUE statements above (new enum values aren't usable in the same txn).
BEGIN;

CREATE TABLE entity_contacts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    name       TEXT,                 -- contact person's name
    role       TEXT,                 -- job title / department
    phone      TEXT,
    email      TEXT,
    label      TEXT,                 -- e.g. "comercial", "suporte", "whatsapp"
    source     TEXT,                 -- business_card | manual | enriched
    metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entity_contacts_entity ON entity_contacts (entity_id);

COMMIT;

-- Rollback (manual):
-- BEGIN;
-- DROP TABLE IF EXISTS entity_contacts;
-- -- enum values added to job_type / conversation_state cannot be dropped in
-- -- Postgres; leaving them in place is harmless.
-- COMMIT;
