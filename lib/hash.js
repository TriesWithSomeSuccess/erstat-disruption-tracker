// lib/hash.js
//
// Body-hash helpers used by every provider. Factored out of the original
// NSH parse.js so all providers compute hashes consistently.
//
// A body_hash is a stable identifier for "this advisory text, attached to
// this facility, about this service". When NSH (or AHS, SHA, etc.) updates
// only the URL tracking parameters or whitespace, the hash stays the same;
// when the substance changes, it differs. Classifications are cached per
// (source, body_hash) so the LLM is called exactly once per unique notice.

const crypto = require('node:crypto');

function normalizeForHash(text) {
  return String(text || '')
    // Strip URL query strings (Outlook safelinks change between scrapes)
    .replace(/(https?:\/\/[^\s)]+?)\?[^\s)]*/g, '$1')
    // Collapse all whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Compute a stable body hash. Pass any number of strings as facets;
 * they will be joined with a separator that can't appear in normal text
 * (Unit Separator, \x1f) and SHA-256'd. Returns the first 32 hex chars
 * (128 bits — far more than needed at our scale).
 *
 * Example:
 *   hash('ns_nshealth_html', 'strait-richmond-hospital', 'Emergency Department', body)
 */
function hash(...facets) {
  const h = crypto.createHash('sha256');
  for (const f of facets) {
    h.update((f || '') + '\x1f');
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * Higher-level helper: hash a body alongside its facility/service/source
 * identifiers, normalizing the body text first.
 */
function hashBody({ source, facility_hint, service_label, body }) {
  return hash(
    source || '',
    facility_hint || '',
    service_label || '',
    normalizeForHash(body)
  );
}

module.exports = { hash, hashBody, normalizeForHash };
