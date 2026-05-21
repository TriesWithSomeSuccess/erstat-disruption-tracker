// migrations/server_endpoints.js
//
// Drop-in Hono router for the generalized /scraper/* endpoints. Mount in
// your existing Hetzner server.js (next to where /nsh/* used to live):
//
//   const scraperRouter = require('./scraper_endpoints');  // (this file, renamed)
//   app.route('/scraper', scraperRouter);
//
// This file replaces the old /nsh/cached-classifications and /nsh/pass.
// The behavior is identical except:
//   1. Endpoint paths are now /scraper/cached-classifications, /scraper/pass
//   2. Every request body includes a `source` field
//   3. All writes go to source_advisories / source_classifications / source_audit_log
//      keyed by (source, body_hash)
//   4. closure_events.source stays per-row (this code passes provider source through)
//
// Auth: X-History-Key header, same as before. The check happens in your
// app-level middleware; this router assumes the request is already authed.

const { Hono } = require('hono');

// Adjust this import to wherever your existing pg pool / client lives.
// Most likely something like:
//   const { pool } = require('./db');
const { pool } = require('./db');  // <-- EDIT THIS LINE if needed

const router = new Hono();

// ============================================================
// POST /scraper/cached-classifications
//
// Body:  { source: 'nshealth_html', body_hashes: ['abc...', 'def...'] }
// Reply: { hits: { 'abc...': {<classification row>}, 'def...': {<row>} } }
//
// Returns only rows whose llm_is_closure IS NOT NULL and llm_error IS NULL
// (i.e. real cached LLM verdicts, not stale failures).
// ============================================================
router.post('/cached-classifications', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source       = body.source;
  const body_hashes  = body.body_hashes;

  if (!source || typeof source !== 'string') {
    return c.json({ error: 'source required' }, 400);
  }
  if (!Array.isArray(body_hashes) || body_hashes.length === 0) {
    return c.json({ hits: {} });
  }

  const rows = await pool.query(
    `SELECT body_hash, llm_is_closure, llm_scope,
            llm_closed_from, llm_closed_until, llm_reopen_phrase,
            llm_confidence, llm_reasoning, llm_model, llm_classified_at,
            llm_error, regex_is_closure, regex_needs_review, regex_source_phrase
       FROM source_classifications
      WHERE source = $1
        AND body_hash = ANY($2::text[])
        AND llm_is_closure IS NOT NULL
        AND llm_error IS NULL`,
    [source, body_hashes]
  );

  const hits = {};
  for (const r of rows.rows) {
    hits[r.body_hash] = r;
  }
  return c.json({ hits });
});

// ============================================================
// POST /scraper/pass
//
// The atomic pass. One transaction does:
//   1. Upsert classifications keyed by (source, body_hash)
//   2. Upsert advisories keyed by (source, body_hash):
//        - First seen: insert with first_seen = now
//        - Already seen: update last_seen = now, clear removed_at
//        - Mark removed_at for any hospital_id no longer in the pass
//          BUT scoped to this source — don't sweep other provinces' rows
//   3. Emit closure events:
//        - 'closed' event for any new currently-closed hospital
//        - 'closed' event with reason update if expected_reopen drifted >15 min
//        - 'reopened' event for any previously closed hospital not in pass
//   4. Append audit_events with this source's tag
//
// Body: {
//   source: 'nshealth_html',
//   entries: [{facility_slug, hospital_id, zone, subject_kind, subject_name,
//              location, type, service, body, body_hash}],
//   classifications: { '<body_hash>': { llm, llm_error, regex } },
//   closure_entries: [{hospital_id, body_hash, reopen_phrase, expected_reopen, reason}],
//   audit_events: [{kind, body_hash?, hospital_id?, detail}],
//   scrape_summary: {...}
// }
// ============================================================
router.post('/pass', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source = body.source;

  if (!source || typeof source !== 'string') {
    return c.json({ error: 'source required' }, 400);
  }

  const entries          = body.entries          || [];
  const classifications  = body.classifications  || {};
  const closure_entries  = body.closure_entries  || [];
  const audit_events     = body.audit_events     || [];

  const REOPEN_DRIFT_MS = 15 * 60 * 1000;
  const result = {
    ok: true,
    classifications: { upserted: 0 },
    advisories:      { upserted: 0, removed: 0 },
    closures:        { closed_emitted_new: 0, closed_emitted_reopen_changed: 0,
                       reopened_emitted: 0, unchanged: 0, skipped_unknown_hospital: 0 },
    audit:           { logged: 0 },
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --------------------------------------------------------
    // 1. Classifications upsert
    // --------------------------------------------------------
    for (const [body_hash, cls] of Object.entries(classifications)) {
      const llm = cls.llm;
      const llm_error = cls.llm_error;
      const regex = cls.regex || {};

      // Build update set: if we have a successful LLM result, fully overwrite.
      // If LLM errored, only update regex columns and llm_error; preserve any
      // previously-successful LLM row so we don't lose cache on transient
      // outages.
      if (llm && !llm_error) {
        await client.query(
          `INSERT INTO source_classifications (
             source, body_hash,
             llm_is_closure, llm_scope, llm_closed_from, llm_closed_until,
             llm_reopen_phrase, llm_confidence, llm_reasoning,
             llm_raw_response, llm_model, llm_classified_at, llm_error,
             regex_is_closure, regex_needs_review, regex_source_phrase,
             regex_classified_at, created_at, updated_at
           ) VALUES (
             $1, $2,
             $3, $4, $5, $6,
             $7, $8, $9,
             $10::jsonb, $11, now(), NULL,
             $12, $13, $14,
             now(), now(), now()
           )
           ON CONFLICT (source, body_hash) DO UPDATE SET
             llm_is_closure      = EXCLUDED.llm_is_closure,
             llm_scope           = EXCLUDED.llm_scope,
             llm_closed_from     = EXCLUDED.llm_closed_from,
             llm_closed_until    = EXCLUDED.llm_closed_until,
             llm_reopen_phrase   = EXCLUDED.llm_reopen_phrase,
             llm_confidence      = EXCLUDED.llm_confidence,
             llm_reasoning       = EXCLUDED.llm_reasoning,
             llm_raw_response    = EXCLUDED.llm_raw_response,
             llm_model           = EXCLUDED.llm_model,
             llm_classified_at   = now(),
             llm_error           = NULL,
             regex_is_closure    = EXCLUDED.regex_is_closure,
             regex_needs_review  = EXCLUDED.regex_needs_review,
             regex_source_phrase = EXCLUDED.regex_source_phrase,
             regex_classified_at = now(),
             updated_at          = now()`,
          [
            source, body_hash,
            llm.is_closure ?? null, llm.scope ?? null,
            llm.closed_from ?? null, llm.closed_until ?? null,
            llm.reopen_phrase ?? null, llm.confidence ?? null, llm.reasoning ?? null,
            llm.raw_response ? JSON.stringify(llm.raw_response) : null,
            llm.model ?? null,
            regex.is_closure ?? null, regex.needs_review ?? null, regex.source_phrase ?? null,
          ]
        );
      } else {
        // LLM error or no LLM: upsert regex side + llm_error only, don't
        // clobber a previously-good llm_* columns.
        await client.query(
          `INSERT INTO source_classifications (
             source, body_hash, llm_error,
             regex_is_closure, regex_needs_review, regex_source_phrase,
             regex_classified_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now())
           ON CONFLICT (source, body_hash) DO UPDATE SET
             llm_error           = EXCLUDED.llm_error,
             regex_is_closure    = EXCLUDED.regex_is_closure,
             regex_needs_review  = EXCLUDED.regex_needs_review,
             regex_source_phrase = EXCLUDED.regex_source_phrase,
             regex_classified_at = now(),
             updated_at          = now()`,
          [source, body_hash, llm_error || null,
           regex.is_closure ?? null, regex.needs_review ?? null, regex.source_phrase ?? null]
        );
      }
      result.classifications.upserted++;
    }

    // --------------------------------------------------------
    // 2. Advisories upsert (mark current pass)
    // --------------------------------------------------------
    const currentHashes = new Set();
    for (const e of entries) {
      currentHashes.add(e.body_hash);
      await client.query(
        `INSERT INTO source_advisories (
           source, facility_slug, hospital_id, zone, subject_kind, subject_name,
           location, type, service, body, body_hash, first_seen, last_seen, removed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), NULL)
         ON CONFLICT (source, body_hash) DO UPDATE SET
           hospital_id  = EXCLUDED.hospital_id,
           zone         = EXCLUDED.zone,
           subject_kind = EXCLUDED.subject_kind,
           subject_name = EXCLUDED.subject_name,
           location     = EXCLUDED.location,
           type         = EXCLUDED.type,
           service      = EXCLUDED.service,
           body         = EXCLUDED.body,
           last_seen    = now(),
           removed_at   = NULL`,
        [
          source,
          e.facility_slug || null, e.hospital_id || null, e.zone || null,
          e.subject_kind || 'facility', e.subject_name || '', e.location || null,
          e.type || '', e.service || '', e.body || '', e.body_hash,
        ]
      );
      result.advisories.upserted++;
    }

    // Sweep: mark removed_at for any advisory from THIS source whose
    // body_hash isn't in the current pass. Scoped strictly by source so we
    // never affect other provinces.
    const sweepRes = await client.query(
      `UPDATE source_advisories
          SET removed_at = now()
        WHERE source = $1
          AND removed_at IS NULL
          AND body_hash <> ALL($2::text[])`,
      [source, [...currentHashes]]
    );
    result.advisories.removed = sweepRes.rowCount;

    // --------------------------------------------------------
    // 3. Closure events
    // --------------------------------------------------------
    // Identify hospitals currently closed via this pass:
    const currentClosedIds = new Set(
      closure_entries.filter(c => c.hospital_id).map(c => c.hospital_id)
    );

    for (const c of closure_entries) {
      if (!c.hospital_id) {
        result.closures.skipped_unknown_hospital++;
        continue;
      }

      // Look up the latest event for this hospital from THIS source.
      const latest = await client.query(
        `SELECT event_type, expected_reopen
           FROM closure_events
          WHERE source = $1 AND hospital_id = $2
          ORDER BY "time" DESC
          LIMIT 1`,
        [source, c.hospital_id]
      );
      const prev = latest.rows[0];

      const newExpect = c.expected_reopen ? new Date(c.expected_reopen) : null;
      const prevExpect = prev?.expected_reopen ? new Date(prev.expected_reopen) : null;

      if (!prev || prev.event_type !== 'closed') {
        // New closure event
        await client.query(
          `INSERT INTO closure_events (
             "time", hospital_id, event_type, reason, expected_reopen,
             source, source_body_hash, reopen_phrase
           ) VALUES (now(), $1, 'closed', $2, $3, $4, $5, $6)`,
          [c.hospital_id, c.reason || null, c.expected_reopen || null,
           source, c.body_hash || null, c.reopen_phrase || null]
        );
        result.closures.closed_emitted_new++;
      } else {
        // Already closed — emit new event only if expected_reopen drifted
        // more than 15 minutes (avoids one-event-per-cron churn).
        const drifted = (newExpect && prevExpect)
          ? Math.abs(newExpect.getTime() - prevExpect.getTime()) > REOPEN_DRIFT_MS
          : (Boolean(newExpect) !== Boolean(prevExpect));
        if (drifted) {
          await client.query(
            `INSERT INTO closure_events (
               "time", hospital_id, event_type, reason, expected_reopen,
               source, source_body_hash, reopen_phrase
             ) VALUES (now(), $1, 'closed', $2, $3, $4, $5, $6)`,
            [c.hospital_id, c.reason || null, c.expected_reopen || null,
             source, c.body_hash || null, c.reopen_phrase || null]
          );
          result.closures.closed_emitted_reopen_changed++;
        } else {
          result.closures.unchanged++;
        }
      }
    }

    // Reopen detection: any hospital from THIS source whose latest event
    // is 'closed' but is not in the current closed set gets a 'reopened'.
    const possiblyReopened = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (hospital_id) hospital_id, event_type
           FROM closure_events
          WHERE source = $1
          ORDER BY hospital_id, "time" DESC
       )
       SELECT hospital_id FROM latest WHERE event_type = 'closed'`,
      [source]
    );

    for (const row of possiblyReopened.rows) {
      if (currentClosedIds.has(row.hospital_id)) continue;
      await client.query(
        `INSERT INTO closure_events ("time", hospital_id, event_type, source)
         VALUES (now(), $1, 'reopened', $2)`,
        [row.hospital_id, source]
      );
      result.closures.reopened_emitted++;
    }

    // --------------------------------------------------------
    // 4. Audit log
    // --------------------------------------------------------
    for (const evt of audit_events) {
      await client.query(
        `INSERT INTO source_audit_log (source, kind, body_hash, hospital_id, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [source, evt.kind || 'unknown', evt.body_hash || null,
         evt.hospital_id || null, evt.detail ? JSON.stringify(evt.detail) : null]
      );
      result.audit.logged++;
    }

    await client.query('COMMIT');
    return c.json(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[/scraper/pass]', err);
    return c.json({ ok: false, error: err.message }, 500);
  } finally {
    client.release();
  }
});

module.exports = router;
