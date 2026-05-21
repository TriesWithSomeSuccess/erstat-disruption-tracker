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
//     "_city_to_id": {           ← optional: city → hospital_id fallback
//       "sundre": "ab_sundrehospitalcarece",
//       ...                         only cities with exactly ONE ER hospital
//     },                            multi-hospital cities are absent (so we
//                                   don't silently mis-assign).
//     "<source-slug>": "<erstat_hospital_id>",
//     ...
//   }
// Keys starting with "_" are metadata and ignored by the slug map.
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
    const empty = { slugs: {}, cities: {} };
    cache.set(providerName, empty);
    return empty;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const slugs = {};
  let cities = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_city_to_id') {
      if (v && typeof v === 'object') cities = v;
      continue;
    }
    if (k.startsWith('_')) continue;
    slugs[k] = v;
  }
  const data = { slugs, cities };
  cache.set(providerName, data);
  return data;
}

/**
 * Build a resolver bound to a single provider's slug map.
 *
 *   const resolver = makeResolver('ns_nshealth');
 *   resolver.lookupSlug('strait-richmond-hospital');  // 'ns_straitrichmondhospit'
 *   resolver.lookupCity('sundre');                     // 'ab_sundrehospitalcarece' or null
 *   resolver.knownHospitalIds();                       // ['ns_aberdeen...', ...]
 */
function makeResolver(providerName) {
  const { slugs, cities } = loadMap(providerName);
  return {
    providerName,

    lookupSlug(slug) {
      if (!slug) return null;
      return slugs[slug] || null;
    },

    /**
     * City fallback: maps a city slug (lowercase, dash-separated) to a
     * hospital_id when that city has exactly one ER hospital. Returns null
     * for unknown or ambiguous (multi-hospital) cities.
     */
    lookupCity(citySlug) {
      if (!citySlug) return null;
      return cities[citySlug] || null;
    },

    knownSlugs() {
      return Object.keys(slugs);
    },

    /**
     * Deduped list of hospital_ids this provider knows about. Used as the
     * safety whitelist for D1 sync — hospitals not in this set are NEVER
     * written to by this provider. Includes both slug map IDs and city
     * map IDs so a city-resolved hospital is also in scope for D1 sync.
     */
    knownHospitalIds() {
      const all = [
        ...Object.values(slugs).filter(v => typeof v === 'string'),
        ...Object.values(cities).filter(v => typeof v === 'string'),
      ];
      return [...new Set(all)];
    },

    /** Number of entries in the slug map (for diagnostics). */
    size() {
      return Object.keys(slugs).length;
    },

    /** Number of cities with single-hospital fallback (for diagnostics). */
    citySize() {
      return Object.keys(cities).length;
    },
  };
}

module.exports = { makeResolver, loadMap, configPathFor };
