-- ============================================================
-- ERstat — Generalize NSH tables for multi-provider scraping
-- Target: TimescaleDB on ts.erstat.ca, db erstat_history
-- Run as: sudo -u postgres psql -d erstat_history -f 002_generalize_sources.sql
--
-- WHAT THIS DOES
--   Renames the NSH-specific schema to be source-agnostic so AHS (Alberta),
--   SHA (Saskatchewan), Horizon (NB), NLHS (Newfoundland), Northern Health
--   (BC), and NTHSSA (NWT) scrapers can share the same tables.
--
--   nshealth_advisories       -> source_advisories       (+ source TEXT)
--   nshealth_classifications  -> source_classifications  (+ source TEXT)
--   nshealth_audit_log        -> source_audit_log        (+ source TEXT)
--
--   Existing data gets 'nshealth_html' as its source value via DEFAULT.
--   Composite uniqueness re-keyed as (source, body_hash) so different
--   provinces can hash identical boilerplate without collision.
--
--   The view current_closures_resolved is rebuilt with the full source
--   priority list including the new provincial sources.
--
-- DEPLOYMENT ORDER (DO THIS, IN THIS ORDER)
--   1. Stop the LXC cron:           sudo systemctl stop cron  (or comment out the crontab line)
--   2. Apply this migration:        sudo -u postgres psql -d erstat_history -f 002_generalize_sources.sql
--   3. Deploy new server.js with /scraper/* endpoints (replaces /nsh/*)
--   4. Deploy new LXC scrapers (this bundle), update cron wrapper path
--   5. Run one manual pass:         /opt/erstat/run-scrape.sh
--   6. Verify D1 Strait Richmond:   wrangler d1 execute ...
--   7. Re-enable cron
--
-- ROLLBACK
--   The reverse migration is recorded at the bottom of this file (commented).
--   If you need to roll back, run those statements inside a BEGIN/COMMIT.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Rename tables to source_* prefix
-- ------------------------------------------------------------
ALTER TABLE nshealth_advisories      RENAME TO source_advisories;
ALTER TABLE nshealth_classifications RENAME TO source_classifications;
ALTER TABLE nshealth_audit_log       RENAME TO source_audit_log;

-- ------------------------------------------------------------
-- 2. Add `source` discriminator column to each
--    DEFAULT 'nshealth_html' backfills existing rows with the legacy source.
-- ------------------------------------------------------------
ALTER TABLE source_advisories      ADD COLUMN source TEXT NOT NULL DEFAULT 'nshealth_html';
ALTER TABLE source_classifications ADD COLUMN source TEXT NOT NULL DEFAULT 'nshealth_html';
ALTER TABLE source_audit_log       ADD COLUMN source TEXT NOT NULL DEFAULT 'nshealth_html';

-- ------------------------------------------------------------
-- 3. Re-key uniqueness on (source, body_hash) so providers can't collide
-- ------------------------------------------------------------

-- source_advisories: drop old single-column UNIQUE, add composite
ALTER TABLE source_advisories
  DROP CONSTRAINT IF EXISTS nshealth_advisories_hash_unique;
ALTER TABLE source_advisories
  ADD  CONSTRAINT source_advisories_source_hash_unique UNIQUE (source, body_hash);

-- source_classifications: drop old PK on body_hash alone, add composite PK
ALTER TABLE source_classifications
  DROP CONSTRAINT IF EXISTS nshealth_classifications_pkey;
ALTER TABLE source_classifications
  ADD  PRIMARY KEY (source, body_hash);

-- ------------------------------------------------------------
-- 4. Rename indexes for readability (optional, but keeps the
--    \d output sensible). Postgres preserves index names through
--    table renames, so they still start with "nshealth_*".
-- ------------------------------------------------------------
ALTER INDEX IF EXISTS nshealth_advisories_hospital_active
  RENAME TO source_advisories_hospital_active;
ALTER INDEX IF EXISTS nshealth_advisories_facility_service_active
  RENAME TO source_advisories_facility_service_active;
ALTER INDEX IF EXISTS nshealth_advisories_last_seen
  RENAME TO source_advisories_last_seen;
ALTER INDEX IF EXISTS nshealth_classifications_disagreement
  RENAME TO source_classifications_disagreement;
ALTER INDEX IF EXISTS nshealth_audit_log_ran_at
  RENAME TO source_audit_log_ran_at;
ALTER INDEX IF EXISTS nshealth_audit_log_kind
  RENAME TO source_audit_log_kind;

-- ------------------------------------------------------------
-- 5. Helpful per-source indexes (small, but make filtering by
--    source efficient as provider count grows)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS source_advisories_source_active
  ON source_advisories (source) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS source_classifications_source
  ON source_classifications (source);
CREATE INDEX IF NOT EXISTS source_audit_log_source
  ON source_audit_log (source, ran_at DESC);

-- ------------------------------------------------------------
-- 6. Rebuild the resolved-closures view with the full provider priority
-- ------------------------------------------------------------
DROP VIEW IF EXISTS current_closures_resolved;

CREATE VIEW current_closures_resolved AS
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
      -- Tier 1: human-confirmed / portal-confirmed
      WHEN 'portal'         THEN 1
      WHEN 'manual'         THEN 1
      -- Tier 2: provincial APIs (when/if they come back)
      WHEN 'nshealth_api'   THEN 2
      -- Tier 3: provincial HTML / structured scrapes
      WHEN 'ahs_bed_space'  THEN 10
      WHEN 'sha_disruptions' THEN 10
      WHEN 'horizon_nb'     THEN 10
      WHEN 'nlhs_updates'   THEN 10
      WHEN 'bc_northern_ed' THEN 10
      WHEN 'nthssa_notices' THEN 10
      WHEN 'nshealth_html'  THEN 10
      ELSE 99
    END,
    event_time DESC
)
SELECT * FROM prioritized WHERE event_type = 'closed';

COMMENT ON VIEW current_closures_resolved IS
  'One row per currently-closed hospital, resolved by latest event from highest-priority source. Tier 1 (portal/manual) beats Tier 2 (provincial APIs) beats Tier 3 (provincial HTML scrapers).';

-- ------------------------------------------------------------
-- 7. Grants — preserve same access pattern erstat user had on old tables
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON source_advisories      TO erstat;
GRANT SELECT, INSERT, UPDATE         ON source_classifications TO erstat;
GRANT SELECT, INSERT                 ON source_audit_log       TO erstat;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO erstat;
GRANT SELECT ON current_closures_resolved TO erstat;

COMMIT;

-- ============================================================
-- Verification
-- ============================================================
\echo '== Renamed tables =='
\dt source_*
\echo
\echo '== source column populated correctly =='
SELECT 'source_advisories' AS tbl, source, count(*) FROM source_advisories GROUP BY source
UNION ALL
SELECT 'source_classifications', source, count(*) FROM source_classifications GROUP BY source
UNION ALL
SELECT 'source_audit_log', source, count(*) FROM source_audit_log GROUP BY source
ORDER BY tbl, source;
\echo
\echo '== Composite uniqueness in place =='
SELECT conname, contype, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid IN ('source_advisories'::regclass, 'source_classifications'::regclass)
   AND contype IN ('u', 'p');
\echo
\echo '== View rebuilt =='
\d+ current_closures_resolved

-- ============================================================
-- ROLLBACK (run inside BEGIN/COMMIT only if you need to revert)
-- ============================================================
-- BEGIN;
--   DROP VIEW IF EXISTS current_closures_resolved;
--   ALTER TABLE source_classifications DROP CONSTRAINT source_classifications_pkey;
--   ALTER TABLE source_classifications ADD PRIMARY KEY (body_hash);
--   ALTER TABLE source_advisories DROP CONSTRAINT source_advisories_source_hash_unique;
--   ALTER TABLE source_advisories ADD CONSTRAINT nshealth_advisories_hash_unique UNIQUE (body_hash);
--   ALTER TABLE source_advisories      DROP COLUMN source;
--   ALTER TABLE source_classifications DROP COLUMN source;
--   ALTER TABLE source_audit_log       DROP COLUMN source;
--   ALTER TABLE source_advisories      RENAME TO nshealth_advisories;
--   ALTER TABLE source_classifications RENAME TO nshealth_classifications;
--   ALTER TABLE source_audit_log       RENAME TO nshealth_audit_log;
--   -- Recreate the old view from migration 001 here.
-- COMMIT;
