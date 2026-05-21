-- ============================================================
-- ERstat — NSH HTML scraper schema (v2: event-sourced)
-- Target: TimescaleDB on ts.erstat.ca, db erstat_history
-- Run as: sudo -u postgres psql -d erstat_history -f 001_init.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Advisory table (textual NSH notices, always populated)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nshealth_advisories (
  id              BIGSERIAL PRIMARY KEY,
  facility_slug   TEXT,
  hospital_id     TEXT,
  zone            TEXT,
  subject_kind    TEXT NOT NULL,
  subject_name    TEXT NOT NULL,
  location        TEXT,
  type            TEXT NOT NULL,
  service         TEXT NOT NULL,
  body            TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at      TIMESTAMPTZ,
  CONSTRAINT nshealth_advisories_hash_unique UNIQUE (body_hash)
);

CREATE INDEX IF NOT EXISTS nshealth_advisories_hospital_active
  ON nshealth_advisories (hospital_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS nshealth_advisories_facility_service_active
  ON nshealth_advisories (facility_slug, service) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS nshealth_advisories_last_seen
  ON nshealth_advisories (last_seen DESC);

COMMENT ON TABLE nshealth_advisories IS
  'Textual notices scraped from nshealth.ca/service-statuses... Always populated regardless of closure classification.';

-- ------------------------------------------------------------
-- 2. Classification cache (LLM results keyed by body_hash)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nshealth_classifications (
  body_hash             TEXT PRIMARY KEY,
  llm_is_closure        BOOLEAN,
  llm_scope             TEXT,
  llm_closed_from       TIMESTAMPTZ,
  llm_closed_until      TIMESTAMPTZ,
  llm_reopen_phrase     TEXT,
  llm_confidence        TEXT,
  llm_reasoning         TEXT,
  llm_raw_response      JSONB,
  llm_model             TEXT,
  llm_classified_at     TIMESTAMPTZ,
  llm_error             TEXT,
  regex_is_closure      BOOLEAN,
  regex_needs_review    BOOLEAN,
  regex_source_phrase   TEXT,
  regex_classified_at   TIMESTAMPTZ DEFAULT now(),
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nshealth_classifications_disagreement
  ON nshealth_classifications (body_hash)
  WHERE llm_is_closure IS NOT NULL
    AND regex_is_closure IS NOT NULL
    AND llm_is_closure <> regex_is_closure;

COMMENT ON TABLE nshealth_classifications IS
  'Per-body-hash classifier cache. LLM is canonical when present; regex is fallback and audit baseline.';

-- ------------------------------------------------------------
-- 3. closure_events: add traceability columns
--    Existing schema:
--      time, hospital_id, event_type, reason, expected_reopen, source
--    The 'source' column already exists. We use it directly with values:
--      'portal' | 'manual' | 'nshealth_api' | 'nshealth_html'
-- ------------------------------------------------------------
ALTER TABLE closure_events ADD COLUMN IF NOT EXISTS source_body_hash TEXT;
ALTER TABLE closure_events ADD COLUMN IF NOT EXISTS reopen_phrase    TEXT;

CREATE INDEX IF NOT EXISTS closure_events_source_hospital_time
  ON closure_events (source, hospital_id, "time" DESC);

-- ------------------------------------------------------------
-- 4. Resolved-closures view (event-sourced + source priority)
--    Per hospital, take the latest event from the highest-priority
--    source whose latest event is 'closed'.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW current_closures_resolved AS
WITH latest_per_source AS (
  SELECT DISTINCT ON (hospital_id, source)
    hospital_id, source, "time" AS event_time, event_type,
    reason, expected_reopen, source_body_hash, reopen_phrase
  FROM closure_events
  ORDER BY hospital_id, source, "time" DESC
),
prioritized AS (
  SELECT DISTINCT ON (hospital_id) *
  FROM latest_per_source
  ORDER BY hospital_id,
    CASE source
      WHEN 'portal'        THEN 1
      WHEN 'manual'        THEN 1
      WHEN 'nshealth_api'  THEN 2
      WHEN 'nshealth_html' THEN 3
      ELSE 99
    END,
    event_time DESC
)
SELECT * FROM prioritized WHERE event_type = 'closed';

COMMENT ON VIEW current_closures_resolved IS
  'One row per currently-closed hospital, resolved by latest event from highest-priority source. Switch reader queries to this view to enable coexistence between API and HTML scrapers.';

-- ------------------------------------------------------------
-- 5. Audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nshealth_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  body_hash       TEXT,
  hospital_id     TEXT,
  detail          JSONB
);

CREATE INDEX IF NOT EXISTS nshealth_audit_log_ran_at
  ON nshealth_audit_log (ran_at DESC);
CREATE INDEX IF NOT EXISTS nshealth_audit_log_kind
  ON nshealth_audit_log (kind, ran_at DESC);

COMMIT;

-- ============================================================
-- Verification
-- ============================================================
\echo '== Tables =='
\dt nshealth_*
\echo
\echo '== closure_events new columns =='
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'closure_events'
   AND column_name IN ('source_body_hash', 'reopen_phrase');
\echo
\echo '== Resolved-closures view =='
\d+ current_closures_resolved
