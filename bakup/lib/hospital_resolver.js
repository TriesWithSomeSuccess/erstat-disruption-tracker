// lib/hospital_resolver.js
//
// Per-provider slug → hospital_id resolver. Each provider has its own JSON
// file at config/providers/{provider.name}.json mirroring the canonical
// hospital identifiers in the backend repo (e.g., NS_HEALTH_SLUG_MAPPING
// in ns-health-service.js for the NSH provider).
//
// File format:
//   {
//     "_comment": "...",
//     "_last_reviewed": "2026-05-10",
//     "<source-slug>": "<erstat_hospital_id>",
//     ...
//   }
// Keys starting with "_" are metadata and ignored.
//
// Why per-provider JSON instead of D1?
//   - D1 round trip on every cron pass is wasted latency
//   - JSON files are checked into git → diff visible, reviewable
//   - Adding a new facility is a one-line PR, no DB migration
// We can move to D1-driven resolution later if the maps get unwieldy.

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

function configPathFor(providerName) {
  return process.env.PROVINCIAL_CONFIG_PATH
    ? path.join(process.env.PROVINCIAL_CONFIG_PATH, `${providerName}.json`)
    : path.join(__dirname, '..', 'config', 'providers', `${providerName}.json`);
}

function loadMap(providerName) {
  if (cache.has(providerName)) return cache.get(providerName);
  const file = configPathFor(providerName);
  if (!fs.existsSync(file)) {
    cache.set(providerName, {});
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    map[k] = v;
  }
  cache.set(providerName, map);
  return map;
}

/**
 * Build a resolver bound to a single provider's slug map.
 *
 *   const resolver = makeResolver('ns_nshealth');
 *   resolver.lookupSlug('strait-richmond-hospital');  // 'ns_straitrichmondhospit'
 *   resolver.knownHospitalIds();                       // ['ns_aberdeen...', ...]
 */
function makeResolver(providerName) {
  const map = loadMap(providerName);
  return {
    providerName,

    lookupSlug(slug) {
      if (!slug) return null;
      return map[slug] || null;
    },

    knownSlugs() {
      return Object.keys(map);
    },

    /**
     * Deduped list of hospital_ids this provider knows about. Used as the
     * safety whitelist for D1 sync — hospitals not in this set are NEVER
     * written to by this provider.
     */
    knownHospitalIds() {
      return [...new Set(Object.values(map).filter(v => typeof v === 'string'))];
    },

    /** Number of entries in the slug map (for diagnostics). */
    size() {
      return Object.keys(map).length;
    },
  };
}

module.exports = { makeResolver, loadMap, configPathFor };
