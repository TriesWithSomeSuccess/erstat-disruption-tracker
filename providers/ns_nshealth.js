// providers/ns_nshealth.js
//
// Nova Scotia Health — Service Statuses, Closures and Cancellations.
// Scrapes https://www.nshealth.ca/service-statuses-closures-and-cancellations
//
// This is the original NSH scraper, refactored as a provider module. The
// only differences from the standalone version:
//   1. Parsing and fetching logic exposed as provider.fetch() / provider.parse()
//   2. ParsedEntry shape standardized (facility_hint instead of facility_slug,
//      service_label instead of service, etc.) — the pipeline's adapter
//      bridges these back to the classifier shape.
//   3. body_hash uses lib/hash.js for cross-provider consistency.

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/fetch');
const { hashBody } = require('../lib/hash');
const { makeResolver } = require('../lib/hospital_resolver');

const BASE = 'https://www.nshealth.ca/service-statuses-closures-and-cancellations';
const PER_PAGE = 10;
const MAX_PAGES = 6;

const TYPE_LABELS = new Set([
  'Disruption',
  'Advisory',
  'Emergency Situation In Progress',
  'As Scheduled',
]);

// Parse the H2 header to learn the total number of advertised entries.
// We use this to bound pagination (MAX_PAGES is a safety ceiling).
function parseTotal(html) {
  const m = html.match(/<strong>\s*(\d+)\s*<\/strong>\s*Service Statuses/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractEntriesFromHtml(html, source) {
  const $ = cheerio.load(html);
  const entries = [];

  $('.views-row').each((_, row) => {
    const $row = $(row);

    // --- type label: the first text node matching a known label ---
    let type = null;
    const allText = $row.text();
    for (const label of TYPE_LABELS) {
      const rx = new RegExp(`(?:^|\\s)${label.replace(/ /g, '\\s+')}(?:\\s|$)`, 'i');
      if (rx.test(allText)) { type = label; break; }
    }
    if (!type) return; // Skip rows without a recognised type label

    // --- facility or zone link ---
    const facilityLink = $row.find('a[href*="/locations-and-facilities/"]').first();
    const zoneLink     = $row.find('a[href*="zone="]').first();

    let facility_hint = null;
    let subject_kind  = null;
    let facility_name = null;
    let zone          = null;

    if (facilityLink.length) {
      const href = facilityLink.attr('href') || '';
      const m = href.match(/\/locations-and-facilities\/([^/?#]+)/);
      facility_hint = m ? m[1] : null;
      facility_name = facilityLink.text().trim();
      subject_kind  = 'facility';
    } else if (zoneLink.length) {
      facility_name = zoneLink.text().trim();
      subject_kind  = 'zone';
      zone          = facility_name;
    } else {
      return; // No subject link — malformed row
    }

    // --- location text in parens ---
    let location = null;
    $row.find('p, span, div').each((_, el) => {
      if (location) return;
      const t = $(el).text().trim();
      const m = t.match(/^\(([^)]+)\)$/);
      if (m) location = m[1].trim();
    });

    // --- service heading from h3 ---
    const service_label = $row.find('h3').first().text().trim() || null;

    // --- body: text after the h3, joined paragraphs ---
    let body = '';
    const $h3 = $row.find('h3').first();
    if ($h3.length) {
      const collectFrom = ($from) => {
        $from.nextAll().each((_, el) => {
          const $el = $(el);
          const tag = el.tagName?.toLowerCase();
          if (tag === 'p' || tag === 'ul' || tag === 'ol' || tag === 'div') {
            const t = $el.text().trim();
            if (t) body += (body ? '\n\n' : '') + t;
          }
        });
      };
      collectFrom($h3);
      if (!body && $h3.parent().length) collectFrom($h3.parent());
    }
    if (!body) {
      // Fallback: take row text minus the type label, name, location, service
      let raw = $row.text();
      raw = raw.replace(type, '');
      if (facility_name) raw = raw.replace(facility_name, '');
      if (location)      raw = raw.replace(`(${location})`, '');
      if (service_label) raw = raw.replace(service_label, '');
      body = raw.replace(/\s+/g, ' ').trim();
    }
    body = body.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) return;

    const body_hash = hashBody({
      source,
      facility_hint,
      service_label,
      body,
    });

    entries.push({
      // Standard ParsedEntry shape (pipeline-readable)
      source_record_id: null,
      facility_name,
      facility_hint,             // the NSH URL slug
      service_label,
      body,
      body_hash,
      type_label: type,
      subject_kind,
      zone,
      location,
      metadata: {},
    });
  });

  return entries;
}

module.exports = {
  name: 'ns_nshealth',
  province: 'NS',
  data_source: 'nshealth_html',
  enabled: true,
  timezone: 'America/Halifax',

  async fetch(/* ctx */) {
    const first = await fetchHtml(BASE);
    const total = parseTotal(first);
    if (total === null) {
      throw new Error('Could not parse total count from H2 — page structure may have changed');
    }
    const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PER_PAGE)));
    const htmlPages = [first];
    for (let p = 1; p < pages; p++) {
      htmlPages.push(await fetchHtml(`${BASE}?page=${p}`));
    }
    return { total, pages, htmlPages };
  },

  parse(raw, /* ctx */) {
    const entries = [];
    for (const html of raw.htmlPages) {
      entries.push(...extractEntriesFromHtml(html, 'nshealth_html'));
    }
    return entries;
  },

  // Provider-specific resolver hook. Default pipeline behavior is to use
  // resolver.lookupSlug(e.facility_hint), which is exactly what NSH needs,
  // but providing it here makes the contract explicit per provider.
  async resolveHospital(entry, ctx) {
    return ctx.resolver.lookupSlug(entry.facility_hint);
  },

  // Scope: every hospital_id in the NSH slug map.
  async scope(ctx) {
    return ctx.resolver.knownHospitalIds();
  },
};

// Allow standalone parse self-test:
//   echo '<html...>' | node providers/ns_nshealth.js
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
    const total = parseTotal(html);
    const entries = extractEntriesFromHtml(html, 'nshealth_html');
    console.log(JSON.stringify({ total_advertised: total, entries_parsed: entries.length, entries }, null, 2));
  })().catch(e => { console.error(e); process.exit(1); });
}
