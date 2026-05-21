// lib/d1_sync.js
//
// After a successful /scraper/pass, push closure state to Cloudflare D1
// (waitlog-db hospitals table) so the frontend reflects current state.
//
// PER-PROVIDER OWNERSHIP
//   Each provider declares its writable scope (hospital_ids it owns). The
//   UPDATE is scoped via `WHERE id IN (whitelist)` so providers cannot
//   write to hospitals outside their scope. Defense in depth.
//
// COLUMNS OWNED (per row in scope)
//   official_status              ('closed' | 'disruption' | 'open')
//   official_status_message      (LLM-derived one-liner, or NULL when open)
//   er_closure_end               (timestamp for full closures, NULL otherwise)
//   official_updated_at          (now)
//
// COLUMNS NEVER TOUCHED BY THIS MODULE
//   advisory_*                   (NSH Worker scrapeNSHealthStatus owns)
//   er_wait_*                    (Worker fetchNSHealthPredictions owns)
//   service_*, portal_*, etc.    (different subsystems)
//
// INPUT SHAPE — closures array elements (built in pipeline.js step 9):
//   {
//     hospital_id:     string,
//     d1_status:       'closed' | 'disruption',
//     d1_message:      string | null,
//     expected_reopen: ISO 8601 with offset | null,    // only for d1_status='closed'
//     ...other fields ignored by this module
//   }
//
// FAILURE MODE
//   If env vars are missing this module returns { skipped: true } and the
//   pass is otherwise unaffected. D1 sync is the visible-to-frontend layer.

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const CF_D1_DB_ID   = process.env.CF_D1_DB_PRODUCTION;

function isConfigured() {
  return Boolean(CF_ACCOUNT_ID && CF_API_TOKEN && CF_D1_DB_ID);
}

// Convert ISO 8601 with offset (LLM output) to UTC naive ISO matching the
// existing D1 storage format. Existing rows store e.g. "2026-05-09T08:00:00"
// (no offset) and the Worker's formatClosureEnd() appends 'Z' when reading.
//   "2026-05-11T08:00:00-03:00" -> "2026-05-11T11:00:00"
//   null / undefined / invalid  -> null
function toD1Timestamp(isoWithOffset) {
  if (!isoWithOffset) return null;
  const d = new Date(isoWithOffset);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

async function d1Query(sql, params) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`
            + `/d1/database/${CF_D1_DB_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`D1 HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`D1 returned non-JSON: ${text.slice(0, 200)}`); }
  if (!json.success) {
    const errs = (json.errors || []).map(e => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`D1 query failed: ${errs || 'unknown'}`);
  }
  return json.result?.[0] || {};
}

// Hospital IDs match a tight regex (alphanumeric + underscore). Validating
// allows safe inlining in SQL, keeping the UPDATE under D1's 100-param cap
// even for province-wide scopes like AHS (113 Alberta hospitals).
// Timestamps and messages still go through bound parameters.
const SAFE_ID = /^[a-z0-9_]+$/i;
function assertSafeId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`unsafe hospital_id rejected for D1 sync: ${JSON.stringify(id)}`);
  }
  return id;
}
function sqlQuoteId(id) { return `'${assertSafeId(id)}'`; }

/**
 * Sync closure state to D1, scoped to one provider's territory.
 *
 * @param {Object} args
 * @param {string} args.provider                  Provider name (for log context)
 * @param {Set<string>|string[]} args.scopeIds    Hospital IDs this provider owns
 * @param {Array<Object>} args.closures           Closure entries from pipeline step 9
 * @returns {Promise<Object>}
 */
async function syncToD1({ provider = 'unknown', scopeIds, closures }) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'CF_API_TOKEN / CF_ACCOUNT_ID / CF_D1_DB_PRODUCTION not set' };
  }
  const scopeSet = scopeIds instanceof Set ? scopeIds : new Set(scopeIds || []);
  if (scopeSet.size === 0) {
    return { skipped: true, reason: `provider ${provider} declared no scope` };
  }

  // Partition closures by status. Defensive defaults preserve backward
  // compatibility for any caller that hasn't been updated to set d1_status:
  // missing → treat as 'closed' (the legacy behavior).
  const closedMap = new Map();      // hospital_id -> { end_ts, message }
  const disruptionMap = new Map();  // hospital_id -> { message }
  for (const c of (closures || [])) {
    if (!c?.hospital_id) continue;
    if (!scopeSet.has(c.hospital_id)) continue;
    const status = c.d1_status || 'closed';
    const message = (c.d1_message && typeof c.d1_message === 'string')
      ? c.d1_message.slice(0, 500)
      : null;
    if (status === 'disruption') {
      disruptionMap.set(c.hospital_id, { message });
    } else {
      closedMap.set(c.hospital_id, {
        end_ts: toD1Timestamp(c.expected_reopen),
        message,
      });
    }
  }

  // Validate all ids up front. Any unsafe id aborts the sync rather than
  // emitting dangerous SQL.
  const allIds = [...scopeSet];
  try {
    allIds.forEach(assertSafeId);
    for (const id of closedMap.keys()) assertSafeId(id);
    for (const id of disruptionMap.keys()) assertSafeId(id);
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }

  // ---- Build a single UPDATE with three CASE expressions ----
  //
  // status      = CASE id WHEN ... 'closed' / 'disruption' / 'open'
  // message     = CASE id WHEN ... ? / NULL
  // er_end      = CASE id WHEN ... ? / NULL
  //
  // SQLite requires at least one WHEN in CASE, so when a map is empty we
  // emit a plain literal instead.

  const hasClosed = closedMap.size > 0;
  const hasDisruption = disruptionMap.size > 0;
  const hasAnyClosure = hasClosed || hasDisruption;

  const sqlParts = ['UPDATE hospitals SET'];
  const params = [];

  // ---- official_status ----
  if (hasAnyClosure) {
    sqlParts.push('  official_status = CASE id');
    for (const id of closedMap.keys()) {
      sqlParts.push(`    WHEN ${sqlQuoteId(id)} THEN 'closed'`);
    }
    for (const id of disruptionMap.keys()) {
      sqlParts.push(`    WHEN ${sqlQuoteId(id)} THEN 'disruption'`);
    }
    sqlParts.push(`    ELSE 'open'`);
    sqlParts.push('  END,');
  } else {
    sqlParts.push(`  official_status = 'open',`);
  }

  // ---- official_status_message ----
  // Bound params (messages are LLM-derived user-facing text, never inline).
  if (hasAnyClosure) {
    sqlParts.push('  official_status_message = CASE id');
    for (const [id, { message }] of closedMap.entries()) {
      sqlParts.push(`    WHEN ${sqlQuoteId(id)} THEN ?`);
      params.push(message);
    }
    for (const [id, { message }] of disruptionMap.entries()) {
      sqlParts.push(`    WHEN ${sqlQuoteId(id)} THEN ?`);
      params.push(message);
    }
    sqlParts.push('    ELSE NULL');
    sqlParts.push('  END,');
  } else {
    sqlParts.push('  official_status_message = NULL,');
  }

  // ---- er_closure_end ----
  // Only set for full closures. Disruptions clear it (no single "end" value).
  if (hasClosed) {
    sqlParts.push('  er_closure_end = CASE id');
    for (const [id, { end_ts }] of closedMap.entries()) {
      sqlParts.push(`    WHEN ${sqlQuoteId(id)} THEN ?`);
      params.push(end_ts);
    }
    sqlParts.push('    ELSE NULL');
    sqlParts.push('  END,');
  } else {
    sqlParts.push('  er_closure_end = NULL,');
  }

  sqlParts.push(`  official_updated_at = datetime('now')`);

  // ---- WHERE — whitelist scope, IDs inlined (validated above) ----
  const idList = allIds.map(sqlQuoteId).join(', ');
  sqlParts.push(`WHERE id IN (${idList})`);

  const sql = sqlParts.join('\n');

  try {
    const result = await d1Query(sql, params);
    return {
      ok: true,
      provider,
      closed_count: closedMap.size,
      disruption_count: disruptionMap.size,
      open_count: allIds.length - closedMap.size - disruptionMap.size,
      rows_affected: result.meta?.changes ?? null,
      duration_ms: result.meta?.duration ?? null,
    };
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }
}

module.exports = { syncToD1, isConfigured, toD1Timestamp };
