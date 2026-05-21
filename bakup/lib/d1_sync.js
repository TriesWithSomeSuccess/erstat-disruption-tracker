// lib/d1_sync.js
//
// After a successful /scraper/pass, push official_status + er_closure_end to
// Cloudflare D1 (waitlog-db hospitals table) so the frontend reflects the
// current closure state.
//
// PER-PROVIDER OWNERSHIP
//   Each provider declares its writable scope (hospital_ids it owns). The
//   UPDATE is scoped via `WHERE id IN (whitelist)` so providers cannot
//   write to hospitals outside their scope. This is the safety net.
//
// COLUMNS OWNED (per row in scope)
//   official_status              ('closed' | 'open')
//   official_status_message      (NULL — matches Worker pattern)
//   er_closure_end               (timestamp or NULL)
//   official_updated_at          (now)
//
// COLUMNS NEVER TOUCHED BY THIS MODULE
//   advisory_*                   (NSH Worker scrapeNSHealthStatus owns)
//   er_wait_*                    (Worker fetchNSHealthPredictions owns)
//   service_*, portal_*, etc.    (different subsystems)
//
// FAILURE MODE
//   If env vars are missing this module returns { skipped: true } and the
//   pass is otherwise unaffected. The TS pass already wrote to TimescaleDB;
//   D1 sync is the visible-to-frontend layer only.

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const CF_D1_DB_ID   = process.env.CF_D1_DB_PRODUCTION;

function isConfigured() {
  return Boolean(CF_ACCOUNT_ID && CF_API_TOKEN && CF_D1_DB_ID);
}

// Convert ISO 8601 with offset (LLM output) to UTC naive ISO matching the
// existing D1 storage format. Existing rows store e.g. "2026-05-09T08:00:00"
// (no offset) and the Worker's formatClosureEnd() appends 'Z' when reading,
// so we have to write UTC naive for round-tripping to be correct.
//
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

/**
 * Sync closure state to D1, scoped to one provider's territory.
 *
 * @param {Object} args
 * @param {string} args.provider            Provider name (for log/error context)
 * @param {Set<string>|string[]} args.scopeIds   Hospital IDs this provider owns
 * @param {Array<{hospital_id: string, expected_reopen: string|null}>} args.closures
 *   Currently-closed hospitals from this provider's pass.
 * @returns {Promise<{ok?: boolean, skipped?: boolean, reason?: string,
 *                    closed_count?: number, open_count?: number,
 *                    rows_affected?: number, error?: string}>}
 */
async function syncToD1({ provider = 'unknown', scopeIds, closures }) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'CF_API_TOKEN / CF_ACCOUNT_ID / CF_D1_DB_PRODUCTION not set' };
  }
  const scopeSet = scopeIds instanceof Set ? scopeIds : new Set(scopeIds || []);
  if (scopeSet.size === 0) {
    return { skipped: true, reason: `provider ${provider} declared no scope` };
  }

  // Filter closures to known-scope hospitals only — defense in depth.
  const closureMap = new Map();
  for (const c of (closures || [])) {
    if (!c?.hospital_id) continue;
    if (!scopeSet.has(c.hospital_id)) continue;
    closureMap.set(c.hospital_id, toD1Timestamp(c.expected_reopen));
  }

  const allIds = [...scopeSet];

  // Single CASE-based UPDATE: one HTTP round trip, atomic on D1's side.
  //
  //   UPDATE hospitals SET
  //     official_status = CASE id WHEN 'X' THEN 'closed' ... ELSE 'open' END,
  //     official_status_message = NULL,
  //     er_closure_end  = CASE id WHEN 'X' THEN ?         ... ELSE NULL  END,
  //     official_updated_at = datetime('now')
  //   WHERE id IN (?, ?, ...)
  //
  // Param budget: closureMap.size (status CASE) + 2*closureMap.size (end CASE)
  //              + allIds.length (WHERE) — well under D1's 100-param limit
  //              for any realistic provider scope.

  const sqlParts = ['UPDATE hospitals SET'];
  const params = [];

  // status CASE
  sqlParts.push('  official_status = CASE id');
  for (const id of closureMap.keys()) {
    sqlParts.push(`    WHEN ? THEN 'closed'`);
    params.push(id);
  }
  sqlParts.push(`    ELSE 'open'`);
  sqlParts.push('  END,');

  sqlParts.push('  official_status_message = NULL,');

  // er_closure_end CASE
  sqlParts.push('  er_closure_end = CASE id');
  for (const [id, end] of closureMap.entries()) {
    sqlParts.push('    WHEN ? THEN ?');
    params.push(id, end);
  }
  sqlParts.push('    ELSE NULL');
  sqlParts.push('  END,');

  sqlParts.push(`  official_updated_at = datetime('now')`);

  // WHERE — whitelist scope
  const idPlaceholders = allIds.map(() => '?').join(', ');
  sqlParts.push(`WHERE id IN (${idPlaceholders})`);
  for (const id of allIds) params.push(id);

  const sql = sqlParts.join('\n');

  try {
    const result = await d1Query(sql, params);
    return {
      ok: true,
      provider,
      closed_count: closureMap.size,
      open_count: allIds.length - closureMap.size,
      rows_affected: result.meta?.changes ?? null,
      duration_ms: result.meta?.duration ?? null,
    };
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }
}

module.exports = { syncToD1, isConfigured, toD1Timestamp };
