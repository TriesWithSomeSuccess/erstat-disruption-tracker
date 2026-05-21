// providers/nb_horizon.js
//
// Horizon Health Network — Temporary Service Interruptions & Closure Notices.
// Source: https://horizonnb.ca/news/temporary-service-interruptions-and-closure-notices/
//
// Horizon publishes all current service interruptions on a SINGLE WordPress
// page (post-16523), not as separate news posts. The page is manually
// edited; entries come and go as the situation changes. The "Last updated:"
// paragraph near the top is the closest thing to an "as of" timestamp.
//
// LAYOUT:
//
//   <article id="post-16523">
//     <div class="entry-content">
//       ... intro paragraphs ...
//       <h3 id="current-temporary-service-interruptions-or-closures">Current...</h3>
//       <p><strong>Last updated:</strong> May 15, 2026</p>
//       <div class="colourful-widget">
//         <div class="content">
//           <table>...<td>Upper River Valley Hospital</td>...</table>  <-- banner
//           <p>Labour and birth services...</p>                         <-- body
//           <p>All pregnant individuals...</p>                          <-- body
//           <p>__</p>                                                   <-- divider
//           <table>...<td>Physiotherapy</td>...</table>                 <-- next entry
//           <p>Horizon is currently experiencing...</p>
//           <ul><li>...</li></ul>
//         </div>
//       </div>
//     </div>
//   </article>
//
// Each entry is anchored on a single-cell <table> whose cell contains the
// facility (or service) name. The body of the entry is every following
// sibling up to the next <table> or <p>__</p> divider.

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/fetch');
const { hashBody } = require('../lib/hash');

const BASE = 'https://horizonnb.ca/news/temporary-service-interruptions-and-closure-notices/';

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

function inferService(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\bphysiotherap/i.test(text))                                                  return 'Physiotherapy';
  if (/\bobstetric|maternity|labou?r|delivery|baby|c-section|caesarian/i.test(text)) return 'Obstetrics';
  if (/\bsurger(?:y|ical)|\bor\s+suite|\boperating\s+room/i.test(text))              return 'Surgery';
  if (/\blaboratory|\blab\s|blood\s+collection|specimen\s+collection/i.test(text))   return 'Laboratory';
  if (/\bx-?ray|radiology|imaging|ct\s+scan|ultrasound/i.test(text))                 return 'Diagnostic Imaging';
  if (/\bpediatric|children|youth/i.test(text))                                      return 'Pediatrics';
  if (/\bmental\s+health|psychiatric|addiction/i.test(text))                         return 'Mental Health';
  return 'Emergency Department';
}

function inferType(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\breopen|back open|resumed|service restored/i.test(text)) return 'Advisory';
  if (/\bclos(?:ure|ed|ing)|interrupt|suspend|reduce|divert|unavailable|shortage/i.test(text)) return 'Disruption';
  return 'Advisory';
}

// ------------------------------------------------------------
// Parser
// ------------------------------------------------------------

function extractEntries(html, source, knownSlugs) {
  const $ = cheerio.load(html);
  const entries = [];

  const $article = $('article[id^="post-"]').first();
  const $entry   = $article.length ? $article.find('.entry-content').first()
                                   : $('.entry-content').first();
  if (!$entry.length) return [];

  // Entries live inside .colourful-widget .content when present, else
  // directly under .entry-content.
  let $container = $entry.find('.colourful-widget .content').first();
  if (!$container.length) $container = $entry;

  const slugsByLen = [...new Set(knownSlugs || [])].sort((a, b) => b.length - a.length);

  // "Last updated" line, when present, is metadata for all entries on the page.
  let pageDate = null;
  const updMatch = $entry.text().match(/Last\s+updated:\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  if (updMatch) pageDate = updMatch[1];

  $container.find('table').each((_, table) => {
    const $table = $(table);
    if ($table.parents('table').length > 0) return;     // skip nested

    const titleRaw = $table.find('td').first().text()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!titleRaw) return;

    let body = '';
    let $cursor = $table.next();
    while ($cursor.length) {
      const tagName = $cursor[0].tagName?.toLowerCase();
      if (tagName === 'table') break;

      const text = $cursor.text()
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text === '__' || /^_{2,}$/.test(text)) break;
      if (!text) { $cursor = $cursor.next(); continue; }

      if (text.length >= 10) {
        body += (body ? '\n\n' : '') + text;
      }
      $cursor = $cursor.next();
    }
    if (!body) return;

    // Substring-match the banner text against known facility slugs.
    // Cross-cutting service banners (Physiotherapy) won't match and fall
    // through to slugify(title) — they'll show as unknown_slug in the
    // audit log, which is the right signal.
    const titleSlug = slugify(titleRaw);
    let facility_hint = null;
    let facility_name = null;
    for (const slug of slugsByLen) {
      if (titleSlug.includes(slug)) {
        facility_hint = slug;
        facility_name = titleRaw;
        break;
      }
    }
    if (!facility_hint) {
      facility_hint = titleSlug;
      facility_name = titleRaw;
    }

    const service_label = inferService(titleRaw, body);
    const type_label = inferType(titleRaw, body);
    const body_hash = hashBody({ source, facility_hint, service_label, body });

    entries.push({
      source_record_id: null,
      facility_name,
      facility_hint,
      service_label,
      body,
      body_hash,
      type_label,
      subject_kind: 'facility',
      zone: null,
      location: null,
      metadata: { page_last_updated: pageDate, raw_title: titleRaw, source_url: BASE },
    });
  });

  return entries;
}

// ------------------------------------------------------------
// Provider interface
// ------------------------------------------------------------

module.exports = {
  name: 'nb_horizon',
  province: 'NB',
  data_source: 'horizon_nb',
  enabled: true,
  timezone: 'America/Moncton',

  async fetch(/* ctx */) {
    const html = await fetchHtml(BASE);
    return { url: BASE, html };
  },

  parse(raw, ctx) {
    const knownSlugs = ctx?.resolver?.knownSlugs?.() || [];
    return extractEntries(raw.html, 'horizon_nb', knownSlugs);
  },

  async resolveHospital(entry, ctx) {
    return ctx.resolver.lookupSlug(entry.facility_hint);
  },

  async scope(ctx) {
    return ctx.resolver.knownHospitalIds();
  },
};

// ------------------------------------------------------------
// CLI self-test:
//   node providers/nb_horizon.js /tmp/horizon.html
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
      const cfg = require('../config/providers/nb_horizon.json');
      for (const k of Object.keys(cfg)) {
        if (!k.startsWith('_')) known_slugs.add(k);
      }
    } catch {}
    const entries = extractEntries(html, 'horizon_nb', [...known_slugs]);
    const summary = {
      entries_parsed: entries.length,
      slugs_seen:    [...new Set(entries.map(e => e.facility_hint))].sort(),
      slugs_unknown: [...new Set(entries.map(e => e.facility_hint))].filter(s => !known_slugs.has(s)).sort(),
      entries: entries.map(e => ({
        facility_name:    e.facility_name,
        facility_hint:    e.facility_hint,
        service:          e.service_label,
        type:             e.type_label,
        body_preview:     e.body.slice(0, 200),
        body_hash:        e.body_hash,
        page_last_updated: e.metadata?.page_last_updated || null,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
  })().catch(e => { console.error(e); process.exit(1); });
}
