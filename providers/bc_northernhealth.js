// providers/bc_northernhealth.js
//
// Northern Health (BC) — Emergency Department status page.
// Source: https://www.northernhealth.ca/emergency-department-status
//
// Northern Health launched this page in January 2026 as a real-time
// service-interruption tracker. The page refreshes every 10 minutes and
// publishes two tables: 18 hospitals (24/7 EDs) and 8 health centres
// (day-only, may offer after-hours but not 24/7).
//
// LAYOUT (Drupal 11):
//
//   <article>
//     ...
//     <h2 or section> with the "Last updated:" line
//     <table>  <!-- Hospitals -->
//       <thead><tr><th>Hospitals</th><th>Current status</th></tr></thead>
//       <tbody>
//         <tr>
//           <td><a href="/find-a-facility/hospitals/...">Bulkley Valley...</a></td>
//           <td>Open</td>
//         </tr>
//         <tr>
//           <td><a href="...">Nats'oojeh Hospital...</a></td>
//           <td>Temporarily Closed</td>
//           <td><strong>Re-opening:</strong> Wed, May 20, 8:00 AM PST</td>
//         </tr>
//         ...
//       </tbody>
//     </table>
//     <table>  <!-- Health centres -->
//       <thead><tr><th>Health centres</th><th>Current status</th></tr></thead>
//       ...
//     </table>
//   </article>
//
// STATUS SEMANTICS (per the page's own definitions):
//
//   "Open"                — service available
//   "Temporarily Closed"  — UNSCHEDULED service interruption during normal
//                           open hours. We emit as is_closure=true.
//   "Closed"              — SCHEDULED outside-of-hours for day-only health
//                           centres. The page distinguishes this from
//                           "Temporarily Closed". We emit as is_closure=false
//                           (advisory only) to avoid false-positive closures
//                           when Atlin Health Centre is just closed overnight
//                           at 2am like it always is.
//
// SAFETY NET:
//   When NH's backend data source fails, the page displays:
//     "Due to a technical issue, the list of Emergency Departments and
//      their current status is temporarily unavailable."
//   If we see that banner OR find zero rows in either table, we abort the
//   parse with an explicit error rather than reporting "everyone is closed"
//   or "everyone is open" — both would be incorrect and dangerous.

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/fetch');
const { hashBody } = require('../lib/hash');

const BASE = 'https://www.northernhealth.ca/emergency-department-status';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''ʼ`'']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Many NH facility names include a parenthetical city, e.g.
// "Bulkley Valley District Hospital (Smithers)". Strip parens for slugging
// so "bulkley-valley-district-hospital" maps cleanly, but keep the original
// name as facility_name for human display.
function nameToSlug(name) {
  const stripped = String(name || '').replace(/\([^)]*\)/g, '').trim();
  return slugify(stripped);
}

// Best-effort extraction of the city from "Foo Hospital (CityName)".
// Some facilities have nested parens like "UHNBC (UHNBC) (Prince George)"
// where the abbreviation comes first and the city last — take the LAST
// parenthetical, since that's reliably the city.
function extractCity(name) {
  const matches = [...String(name || '').matchAll(/\(([^)]+)\)/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s.includes('temporarily closed') || s.includes('temporarily-closed')) return 'temporarily_closed';
  if (s === 'closed' || s.startsWith('closed')) return 'closed';
  if (s === 'open' || s.startsWith('open')) return 'open';
  return 'unknown';
}

// Re-opening cell example: "Re-opening: Wed, May 20, 8:00 AM PST"
// Parse to ISO 8601 with the appropriate offset. PST = UTC-8, MST = UTC-7,
// PDT = UTC-7 (DST), MDT = UTC-6 (DST). NH facilities sit across PST/MST
// boundaries (Tumbler Ridge, Hudson's Hope on Mountain time; rest on Pacific).
const TZ_OFFSETS = {
  PST: '-08:00', PDT: '-07:00',
  MST: '-07:00', MDT: '-06:00',
};

function parseReopen(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/^.*?re-?opening:?\s*/i, '').trim();
  // "Wed, May 20, 8:00 AM PST"
  const m = text.match(/(?:\w+,\s*)?([a-z]+)\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)\s+([A-Z]{2,4})/i);
  if (!m) return null;
  const [, monthName, day, hourStr, minute, ampm, tz] = m;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const monthIdx = months.indexOf(monthName.toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;
  let hour = parseInt(hourStr, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  // Year — choose nearest year (next 6 months window)
  const now = new Date();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), monthIdx, parseInt(day, 10), hour, parseInt(minute, 10)));
  // If the parsed date is more than a month in the past, assume next year.
  if (candidate.getTime() < now.getTime() - 30 * 86400 * 1000) {
    candidate.setUTCFullYear(now.getUTCFullYear() + 1);
  }
  const offset = TZ_OFFSETS[tz.toUpperCase()] || '-08:00';
  const yyyy = candidate.getUTCFullYear();
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(parseInt(day, 10)).padStart(2, '0');
  const HH = String(hour).padStart(2, '0');
  const MM = minute;
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:00${offset}`;
}

// ------------------------------------------------------------
// Core extraction
// ------------------------------------------------------------

const TECH_FAILURE_PHRASE = /list of emergency departments and their current status is temporarily unavailable/i;

function extractEntries(html, source) {
  const $ = cheerio.load(html);

  // We delay the backend-down check until AFTER parsing. The NH page
  // includes a dormant fallback message in the HTML at all times:
  //   "Due to a technical issue, the list of Emergency Departments
  //    and their current status is temporarily unavailable."
  // It's hidden via CSS/JS when the real tables are populated. Checking
  // body text up-front falsely fires on every successful pass. Instead,
  // we treat the message as authoritative ONLY if we extract zero rows
  // — in which case there genuinely is nothing else to go on.
  const pageText = $('body').text();
  const backendDownMessagePresent = TECH_FAILURE_PHRASE.test(pageText);

  // Locate the two data tables. We identify them by header text rather
  // than position, so Drupal layout changes don't silently break this.
  const tables = $('table').toArray();
  let hospitalsTable = null;
  let healthCentresTable = null;
  for (const t of tables) {
    const head = $(t).find('thead').text().toLowerCase();
    if (!hospitalsTable     && head.includes('hospital')) hospitalsTable     = t;
    if (!healthCentresTable && head.includes('health centre')) healthCentresTable = t;
  }

  if (!hospitalsTable && !healthCentresTable) {
    // No tables at all — either backend is genuinely down (warning visible)
    // or the Drupal layout changed and our selectors miss the new structure.
    const err = backendDownMessagePresent
      ? new Error('NH page reports backend data unavailable — aborting parse to avoid emitting false status')
      : new Error('NH page structure unrecognised — no hospital or health-centre tables found');
    err.code = backendDownMessagePresent ? 'NH_BACKEND_DOWN' : 'NH_LAYOUT_CHANGED';
    throw err;
  }

  const entries = [];

  function processTable(tableEl, facilityKind) {
    if (!tableEl) return;
    $(tableEl).find('tbody tr').each((_, tr) => {
      const cells = $(tr).find('td').toArray();
      if (cells.length < 2) return;

      const nameCell = $(cells[0]);
      const statusCell = $(cells[1]);
      const reopenCell = cells[2] ? $(cells[2]) : null;

      const facility_name = nameCell.text().trim();
      if (!facility_name) return;

      const statusRaw = statusCell.text().trim();
      const status = normaliseStatus(statusRaw);
      if (status === 'unknown') return;  // skip rows with unrecognised status

      const reopenRaw = reopenCell ? reopenCell.text().trim() : null;
      const closed_until = parseReopen(reopenRaw);

      const facility_hint = nameToSlug(facility_name);
      const city          = extractCity(facility_name);
      const service_label = 'Emergency Department';

      // Body: short human-readable description suitable for advisory display.
      let body;
      if (status === 'temporarily_closed') {
        body = `Service interruption: emergency department is temporarily closed during normal open hours.`;
        if (reopenRaw) body += ` ${reopenRaw}`;
      } else if (status === 'closed') {
        // For health centres, "Closed" without "Temporarily" means scheduled
        // overnight closure — the facility is operating on its normal hours.
        body = facilityKind === 'health_centre'
          ? `Currently outside normal operating hours.${reopenRaw ? ' ' + reopenRaw : ''}`
          : `Closed.${reopenRaw ? ' ' + reopenRaw : ''}`;
      } else {
        body = 'Emergency department is open.';
      }

      const body_hash = hashBody({ source, facility_hint, service_label, body });

      // Closure classification rules:
      //   temporarily_closed  → is_closure=true (unscheduled interruption)
      //   closed (health ctr) → is_closure=false (normal overnight hours)
      //   closed (hospital)   → is_closure=true (this shouldn't happen but
      //                          if a 24/7 hospital is listed as "Closed",
      //                          treat as closure — likely a label edge case)
      //   open                → is_closure=false
      const is_closure = (status === 'temporarily_closed')
                       || (status === 'closed' && facilityKind === 'hospital');

      const type_label = is_closure ? 'Temporary Closure' : 'Status Update';

      entries.push({
        source_record_id: null,
        facility_name,
        facility_hint,
        city,
        service_label,
        body,
        body_hash,
        type_label,
        subject_kind: 'facility',
        zone: null,
        location: null,
        metadata: {
          source_url: BASE,
          facility_kind: facilityKind,   // 'hospital' | 'health_centre'
          status,                         // 'open' | 'temporarily_closed' | 'closed'
          status_raw: statusRaw,
        },
        // Pre-classified (skip regex+LLM step in pipeline)
        llm: {
          is_closure,
          scope:         is_closure ? 'full' : null,
          closed_from:   null,
          closed_until,
          reopen_phrase: reopenRaw || null,
          confidence:    'high',     // deterministic parse, no model uncertainty
          reasoning:     `Northern Health status table: "${statusRaw}"`,
          model:         null,
        },
      });
    });
  }

  processTable(hospitalsTable, 'hospital');
  processTable(healthCentresTable, 'health_centre');

  if (entries.length === 0) {
    // Tables existed but yielded no rows. Distinguish backend-down (warning
    // is visible — NH knows their data is broken) from layout-changed
    // (tables present but our cell selectors mismatch the new HTML).
    const err = backendDownMessagePresent
      ? new Error('NH page reports backend data unavailable — aborting parse to avoid emitting false status')
      : new Error('NH page parsed but yielded zero rows — likely structural change');
    err.code = backendDownMessagePresent ? 'NH_BACKEND_DOWN' : 'NH_NO_ROWS';
    throw err;
  }

  return entries;
}

// ------------------------------------------------------------
// Provider interface
// ------------------------------------------------------------

module.exports = {
  name: 'bc_northernhealth',
  province: 'BC',
  data_source: 'nh_ed_status',
  enabled: true,
  timezone: 'America/Vancouver',

  async fetch(/* ctx */) {
    const html = await fetchHtml(BASE);
    return { url: BASE, html };
  },

  parse(raw, ctx) {
    return extractEntries(raw.html, 'nh_ed_status');
  },

  async resolveHospital(entry, ctx) {
    // Try slug-direct first, then city fallback (NH facility names
    // often follow "Hospital Name (City)" so the city-map is reliable).
    const direct = ctx.resolver.lookupSlug(entry.facility_hint);
    if (direct) return direct;

    if (entry.city && typeof ctx.resolver.lookupCity === 'function') {
      const citySlug = slugify(entry.city);
      const cityHit = ctx.resolver.lookupCity(citySlug);
      if (cityHit) {
        entry.metadata = { ...(entry.metadata || {}), resolved_via: 'city-fallback', matched_city: citySlug };
        return cityHit;
      }
    }

    // Last resort: substring match against known slugs (handles minor
    // variation like Wikipedia-style hyphenation differences)
    const known = ctx.resolver.knownSlugs().sort((a, b) => b.length - a.length);
    for (const k of known) {
      if (entry.facility_hint.includes(k)) {
        entry.metadata = { ...(entry.metadata || {}), resolved_via: 'slug-substring', matched_slug: k };
        return ctx.resolver.lookupSlug(k);
      }
    }
    return null;
  },

  async scope(ctx) {
    return ctx.resolver.knownHospitalIds();
  },
};

// ------------------------------------------------------------
// CLI self-test:
//   node providers/bc_northernhealth.js /tmp/nh.html
// ------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const fs = require('node:fs');
    let html = '';
    if (process.argv[2]) {
      html = fs.readFileSync(process.argv[2], 'utf8');
    } else {
      html = await new Promise((res) => {
        let buf = ''; process.stdin.on('data', c => buf += c); process.stdin.on('end', () => res(buf));
      });
    }
    const known_slugs = new Set();
    try {
      const cfg = require('../config/providers/bc_northernhealth.json');
      for (const k of Object.keys(cfg)) {
        if (!k.startsWith('_')) known_slugs.add(k);
      }
    } catch {}
    let entries;
    try {
      entries = extractEntries(html, 'nh_ed_status');
    } catch (e) {
      console.error('PARSE ERROR:', e.code || 'UNKNOWN', e.message);
      process.exit(2);
    }
    const summary = {
      entries_parsed: entries.length,
      hospitals:      entries.filter(e => e.metadata.facility_kind === 'hospital').length,
      health_centres: entries.filter(e => e.metadata.facility_kind === 'health_centre').length,
      closures:       entries.filter(e => e.llm.is_closure).length,
      slugs_seen:     [...new Set(entries.map(e => e.facility_hint))].sort(),
      slugs_unknown:  [...new Set(entries.map(e => e.facility_hint))].filter(s => !known_slugs.has(s)).sort(),
      cities_seen:    [...new Set(entries.map(e => e.city).filter(Boolean))].sort(),
      entries: entries.map(e => ({
        facility_name:  e.facility_name,
        facility_hint:  e.facility_hint,
        city:           e.city,
        kind:           e.metadata.facility_kind,
        status:         e.metadata.status,
        is_closure:     e.llm.is_closure,
        closed_until:   e.llm.closed_until,
        body:           e.body,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
  })().catch(e => { console.error(e); process.exit(1); });
}
