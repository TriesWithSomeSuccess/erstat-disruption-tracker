// providers/nb_horizon.js
//
// Horizon Health Network — Temporary Service Interruptions & Closure Notices.
// Source: https://horizonnb.ca/news/temporary-service-interruptions-and-closure-notices/
//
// Horizon's site is WordPress. The closure-notices page is a flat archive of
// individual posts, each representing one closure event. Each post has:
//   - a title (often "Temporary ED closure at <Facility>" or "<Facility>
//     temporary service interruption")
//   - a date (post date, separate from the closure window)
//   - body paragraphs describing the closure window, reason, and what to do
//
// We extract one ParsedEntry per post. Facility identification happens by
// fuzzy-matching the title against known Horizon facility names, then
// resolving the matched name through the slug map.
//
// We DELIBERATELY don't pre-filter by service type. The shared classifier
// (regex + LLM) handles is_closure determination. Non-ED disruptions still
// get stored as advisories — they just don't generate closure events.

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/fetch');
const { hashBody } = require('../lib/hash');

const BASE = 'https://horizonnb.ca/news/temporary-service-interruptions-and-closure-notices/';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// Slugify a facility name to a stable lookup key. Aggressive — strip
// punctuation, lowercase, hyphenate. The config map keys must follow the
// same convention.
function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')            // strip combining diacritics
    .toLowerCase()
    .replace(/[''ʼ`'']/g, '')                   // strip apostrophes entirely
    .replace(/[^a-z0-9]+/g, '-')                // anything else -> hyphen
    .replace(/^-+|-+$/g, '');                   // trim leading/trailing
}

// Pull a facility name out of a post title. Horizon's titles are
// reasonably consistent but vary in phrasing — try a sequence of patterns
// from most-specific to most-permissive.
function facilityFromTitle(title) {
  if (!title) return null;
  // Remove "Update:" / "UPDATE -" prefixes so they don't confuse the patterns
  const t = title.replace(/^(update|notice|advisory)\s*[:\-–—]\s*/i, '').trim();

  // Pattern 1: "... at <Facility>" — most common Horizon pattern.
  //   "Temporary closure at Sussex Health Centre"
  //   "Service interruption at Sackville Memorial Hospital"
  let m = t.match(/(?:closure|closed|reopening|reopened|interruption|disruption|reduction|reduced|suspension|update)\s+(?:at|for|to|in)\s+(?:the\s+)?(.+?)(?:\s*[—\-–:|,]|\s+ED|\s+emergency|$)/i);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 2: "<Facility> — temporary closure" etc.
  m = t.match(/^([A-Z][A-Za-z'\-\s.]+?(?:Hospital|Health Centre|Health Center|Medical Centre))\s*[—\-–:|]/);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 3: bare facility name embedded anywhere in the title.
  //   "Update on Sackville Memorial Hospital ED services"
  m = t.match(/\b((?:[A-Z][a-zA-Z'\-]+\s+){1,4}(?:Hospital|Health Centre|Health Center|Medical Centre|Regional))\b/);
  if (m && m[1]) return cleanFacility(m[1]);

  return null;
}

function cleanFacility(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/i, '')
    .replace(/\s+(?:ED|emergency department|emergency room|er)\s*$/i, '')
    .trim();
}

// Coarse service classification from the post's title + body. The LLM will
// be the canonical classifier; this is just to populate the `service` field
// on the advisory row for analytical filtering. Default to 'Emergency
// Department' for Horizon since this page's primary content is ED closures.
function inferService(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\bobstetric|maternity|labour|labor|delivery|baby/i.test(text)) return 'Obstetrics';
  if (/\bsurger(?:y|ical)|\bor\s+suite|\boperating\s+room/i.test(text)) return 'Surgery';
  if (/\blaboratory|\blab\s|blood\s+collection|specimen\s+collection/i.test(text)) return 'Laboratory';
  if (/\bx-?ray|radiology|imaging|ct\s+scan|ultrasound/i.test(text)) return 'Diagnostic Imaging';
  if (/\bpediatric|children|youth/i.test(text)) return 'Pediatrics';
  // Default: ED. Horizon's dedicated page is overwhelmingly ED-related.
  return 'Emergency Department';
}

// Coarse type tag. The classifier filters on this string + service in
// classify_regex.js, so values should align with the NSH set:
// 'Disruption', 'Advisory', 'Emergency Situation In Progress', 'As Scheduled'.
function inferType(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\breopen|back open|resumed|service restored/i.test(text)) return 'Advisory';
  if (/\bclos(?:ure|ed|ing)|interrupt|suspend|reduce|divert/i.test(text)) return 'Disruption';
  return 'Advisory';
}

// ------------------------------------------------------------
// Parser
// ------------------------------------------------------------

function extractEntries(html, source) {
  const $ = cheerio.load(html);
  const entries = [];

  // Try the standard WordPress post selectors in order of specificity.
  // The first one that yields any matches becomes the post container.
  const candidates = [
    'article.post',
    'article.type-post',
    'article[id^="post-"]',
    'article',
    '.post',
    '.news-item',
    '.entry',
  ];
  let postSel = null;
  for (const sel of candidates) {
    if ($(sel).length > 0) { postSel = sel; break; }
  }
  if (!postSel) {
    // No recognizable post structure — return empty and let the caller log
    // a parse error. We deliberately don't try to scrape <p> tags off the
    // body root: too easy to invent fake entries.
    return [];
  }

  $(postSel).each((_, post) => {
    const $post = $(post);

    // ---- Title ----
    const $title = $post.find('h1.entry-title, h2.entry-title, h3.entry-title, h1, h2, h3').first();
    const title = $title.text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    // ---- Body ----
    const $content = $post.find('.entry-content, .post-content, .entry-body, .content').first();
    const $bodySource = $content.length ? $content : $post;
    let body = '';
    $bodySource.find('p, li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      // Filter out trivial fragments (dates, single words, etc.)
      if (t && t.length >= 15) body += (body ? '\n\n' : '') + t;
    });
    if (!body) return;

    // ---- Post date (for metadata, not classification) ----
    const $time = $post.find('time, .entry-date, .published, .post-date').first();
    const postDate = $time.attr('datetime') || $time.text().trim() || null;

    // ---- Permalink (stable per-post URL, useful for traceability) ----
    const permalink = $post.find('h1 a, h2 a, h3 a, .entry-title a, .permalink').first().attr('href') || null;

    // ---- Facility ----
    const facility_name = facilityFromTitle(title);
    if (!facility_name) {
      // Can't identify a facility — skip. (Pipeline will see fewer entries,
      // not log unknown_slug for these. If lots of posts are skipped, that's
      // a parser tuning signal, surfaced via fetched vs parsed counts.)
      return;
    }

    const facility_hint = slugify(facility_name);
    const service_label = inferService(title, body);
    const type_label = inferType(title, body);

    const body_hash = hashBody({
      source,
      facility_hint,
      service_label,
      body,
    });

    entries.push({
      source_record_id: permalink || null,
      facility_name,
      facility_hint,
      service_label,
      body,
      body_hash,
      type_label,
      subject_kind: 'facility',
      zone: null,
      location: null,
      metadata: { post_date: postDate, raw_title: title, permalink },
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
  timezone: 'America/Moncton',  // NB observes Atlantic Time, same as NS

  async fetch(/* ctx */) {
    const html = await fetchHtml(BASE);
    return { url: BASE, html };
  },

  parse(raw, /* ctx */) {
    return extractEntries(raw.html, 'horizon_nb');
  },

  // The pipeline default lookupSlug(facility_hint) is what we want.
  async resolveHospital(entry, ctx) {
    return ctx.resolver.lookupSlug(entry.facility_hint);
  },

  async scope(ctx) {
    return ctx.resolver.knownHospitalIds();
  },
};

// ------------------------------------------------------------
// CLI self-test: dump parsed entries from a saved HTML file
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
    const entries = extractEntries(html, 'horizon_nb');
    const known_slugs = new Set();
    try {
      const cfg = require('../config/providers/nb_horizon.json');
      for (const k of Object.keys(cfg)) {
        if (!k.startsWith('_')) known_slugs.add(k);
      }
    } catch {}

    const summary = {
      entries_parsed: entries.length,
      slugs_seen:    [...new Set(entries.map(e => e.facility_hint))].sort(),
      slugs_unknown: [...new Set(entries.map(e => e.facility_hint))].filter(s => !known_slugs.has(s)).sort(),
      entries: entries.map(e => ({
        facility_name: e.facility_name,
        facility_hint: e.facility_hint,
        service:       e.service_label,
        type:          e.type_label,
        body_preview:  e.body.slice(0, 150),
        body_hash:     e.body_hash,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
  })().catch(e => { console.error(e); process.exit(1); });
}
