-- 008_contact_name_search.sql
-- Additive migration on top of 007_collections.sql.
--
-- CONTACT-NAME SEARCH
--   "consultar" search was purely semantic (vector match over each entity's
--   description embedding). A person's name (e.g. a CEO) lives in
--   entity_contacts and never reaches that embedding or the LLM reranker, so a
--   query like "Humberto Greco" returned 0 matches even though he is the CEO of
--   a confirmed business. We now also do a direct, case-insensitive substring
--   lookup against entity_contacts.name and merge those hits into the results
--   (see Repository.findEntitiesByContactName / flow.searchConfirmed).
--
--   pg_trgm + a GIN trigram index keep that ILIKE '%...%' lookup fast and
--   typo-tolerant as the contacts table grows.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Supports case-insensitive substring (ILIKE '%name%') and fuzzy matching on
-- the contact person's name.
CREATE INDEX IF NOT EXISTS idx_entity_contacts_name_trgm
    ON entity_contacts USING gin (name gin_trgm_ops);

COMMIT;

-- Rollback (manual):
-- BEGIN;
-- DROP INDEX IF EXISTS idx_entity_contacts_name_trgm;
-- -- pg_trgm is left installed; dropping a shared extension is rarely desired.
-- COMMIT;
