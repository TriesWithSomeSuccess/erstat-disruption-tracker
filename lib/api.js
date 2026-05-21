// lib/api.js
//
// HTTP client for the ts.erstat.ca scraper endpoints. Replaces the old
// NSH-specific /nsh/cached-classifications and /nsh/pass routes with
// generic /scraper/cached-classifications and /scraper/pass that take a
// `source` field in the body — letting every province share one endpoint.
//
// Auth: X-History-Key header, same as snapshot-to-ts.js.

const TS_API_URL = process.env.TS_API_URL;
const TS_API_KEY = process.env.TS_API_KEY;

if (!TS_API_URL) throw new Error('TS_API_URL env var required (e.g. https://ts.erstat.ca)');
if (!TS_API_KEY) throw new Error('TS_API_KEY env var required');

async function call(path, body, { timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${TS_API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-History-Key': TS_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    if (process.env.SCRAPER_API_DEBUG === '1') {
      console.error(`[api] ${Date.now() - t0}ms POST ${path}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Look up cached classifications for a batch of body_hashes for a given source.
 *
 * @param {string} source         Provider data_source (e.g., 'nshealth_html', 'ahs_bed_space')
 * @param {string[]} body_hashes  List of hashes to look up
 * @returns {Promise<Object<string, CachedClassification>>}  Map of body_hash → cached row
 */
async function lookupCachedClassifications(source, body_hashes) {
  if (!body_hashes || body_hashes.length === 0) return {};
  if (!source) throw new Error('lookupCachedClassifications requires source');
  const r = await call('/scraper/cached-classifications', { source, body_hashes });
  return r.hits || {};
}

/**
 * Atomic pass: classifications upsert + advisories upsert+sweep + closure events +
 * audit log. The server does all of this in one transaction.
 *
 * @param {Object} payload
 * @param {string} payload.source             Provider data_source
 * @param {Array}  payload.entries            ParsedEntry-shaped objects
 * @param {Object} payload.classifications    map of body_hash → classification
 * @param {Array}  payload.closure_entries    currently-closed hospitals
 * @param {Array}  payload.audit_events
 * @param {Object} payload.scrape_summary
 */
async function applyPass(payload) {
  if (!payload?.source) throw new Error('applyPass requires source');
  return await call('/scraper/pass', payload, { timeoutMs: 60_000 });
}

module.exports = { lookupCachedClassifications, applyPass };
