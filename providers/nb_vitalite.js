// providers/nb_vitalite.js
//
// Vitalité Health Network — Public Notices / News and Events.
// Source: https://www.vitalitenb.ca/en/news-and-events
//
// Vitalité is NB's francophone health network. Unlike Horizon (which has a
// dedicated closure page), Vitalité's news-and-events index is a generic
// press-release stream — closures, hires, awards, public consultations, etc.
// all live in the same list. We filter to closure-related posts at parse
// time using keyword matching in both English and French (titles may
// occasionally appear in French even on the English page when the post
// references facilities by their formal French names — "Hôpital de
// Tracadie-Sheila" etc.).
//
// Slug resolution: facility names can appear in either language depending on
// the post. The config maps both English and French slug forms of each
// facility to the same hospital_id.

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/fetch');
const { hashBody } = require('../lib/hash');

const BASE = 'https://www.vitalitenb.ca/en/news-and-events';
const MAX_PAGES = 3;  // depth of news index pagination to walk

// Patterns that indicate a post is closure/disruption-related. Bilingual.
// If a title OR body matches ANY of these, the entry passes the filter.
// False positives are cheap (LLM will refine); false negatives mean we
// miss closures, which is what we're optimizing against.
const CLOSURE_KEYWORDS = [
  // English
  /\bclos(?:ed|ure|ing)\b/i,
  /\binterruption\b/i,
  /\bdisruption\b/i,
  /\bemergency\s+(?:department|room|services?)\b/i,
  /\bED\b/,
  /\breopen(?:ed|ing)?\b/i,
  /\bservice\s+restored\b/i,
  /\breduc(?:ed|tion)\b/i,
  /\bsuspend(?:ed|sion)?\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\bobstetric|maternity|labour|delivery\b/i,
  /\bdivert(?:ed|ing|sion)?\b/i,
  // French
  /\bfermeture\b/i,
  /\bferm(?:é|ee?)e?s?\b/i,
  /\binterruption\s+(?:de\s+service|temporaire)\b/i,
  /\bservice\s+d['']urgence|urgence\s+ferm/i,
  /\brupture\s+de\s+service\b/i,
  /\btemporair(?:e|ement)\b/i,
  /\bsuspendu(?:e|s)?\b/i,
  /\bréouverture|rouvert(?:e|s)?\b/i,
  /\bréduct(?:ion|ions)\b/i,
  /\bobstétrique|maternité|accouchement\b/i,
];

function looksLikeClosurePost(title, body) {
  const text = `${title || ''}\n${body || ''}`;
  return CLOSURE_KEYWORDS.some(rx => rx.test(text));
}

// Diacritic-stripping slugify so French/English variants converge:
//   "Hôpital régional Chaleur" -> "hopital-regional-chaleur"
//   "Chaleur Regional Hospital" -> "chaleur-regional-hospital"
// Both can live in the same config pointing to the same hospital_id.
function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''ʼ`'']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanFacility(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/^(?:the\s+|l['']\s*|de\s+|du\s+|de\s+la\s+)/i, '')
    .replace(/\s+(?:ED|emergency department|emergency room|er|urgence)\s*$/i, '')
    .trim();
}

function facilityFromTitle(title) {
  if (!title) return null;
  const t = title.replace(/^(update|notice|advisory|mise\s+à\s+jour|avis)\s*[:\-–—]\s*/i, '').trim();

  // Pattern 1: "... at <Facility>" — English
  let m = t.match(/(?:closure|closed|interruption|disruption|reopening|reopened|update|suspension|suspended|reduction|reduced)\s+(?:at|in|to|of|for)\s+(?:the\s+)?(.+?)(?:\s*[—\-–:|,]|\s+ED|\s+emergency|$)/i);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 2: "... à <Facility>" / "... au <Facility>" — French
  m = t.match(/(?:fermeture|interruption|réouverture|rupture|suspension|réduction)\s+(?:à\s+(?:l['']?\s*)?|au\s+|de\s+(?:l['']?\s*)?|du\s+)?(.+?)(?:\s*[—\-–:|,]|$)/i);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 3: leading facility name then dash
  m = t.match(/^((?:Hôpital|Hôtel-Dieu|Centre hospitalier)[A-Za-zÀ-ÿ'\-\s.]+?)\s*[—\-–:|]/);
  if (m && m[1]) return cleanFacility(m[1]);

  m = t.match(/^([A-Z][A-Za-z'\-\s.]+?(?:Hospital|Health Centre|Health Center|Regional|Medical Centre))\s*[—\-–:|]/);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 4: bare facility mention embedded — English
  m = t.match(/\b((?:[A-Z][a-zA-Z'\-]+\s+){1,4}(?:Hospital|Health Centre|Health Center|Medical Centre|Regional))\b/);
  if (m && m[1]) return cleanFacility(m[1]);

  // Pattern 5: bare facility mention embedded — French
  m = t.match(/\b((?:Hôpital|Hôtel-Dieu|Centre\s+hospitalier)(?:[A-Za-zÀ-ÿ'\-]|\s)+?)(?:\s+(?:est|sera|will|en|du|de)\b|$)/);
  if (m && m[1]) return cleanFacility(m[1]);

  return null;
}

function inferService(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\bobstetric|maternity|labour|delivery|obstétrique|maternité|accouchement/i.test(text)) return 'Obstetrics';
  if (/\bsurger(?:y|ical)|chirurgie/i.test(text)) return 'Surgery';
  if (/\bpediatric|pédiatrie/i.test(text)) return 'Pediatrics';
  if (/\bemergency|urgence|\bed\b|\ber\b/i.test(text)) return 'Emergency Department';
  return 'Emergency Department';
}

function inferType(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (/\breopen|back open|resumed|service restored|réouverture|rouvert/i.test(text)) return 'Advisory';
  if (/\bclos(?:ure|ed|ing)|interrupt|suspend|reduce|divert|fermé|fermeture|réduit|rupture|suspendu/i.test(text)) return 'Disruption';
  return 'Advisory';
}

// ------------------------------------------------------------
// Parser — defensive against multiple Drupal/WordPress structures
// ------------------------------------------------------------
//
// Facility identification strategy:
//   PRIMARY: substring-match the slugified title against the provider's
//   known-slug list (longest match wins). This is the cleanest path because
//   the slug map already enumerates every English + French variant we care
//   about; we just need to find which one appears in the title.
//
//   FALLBACK: regex-based facility name extraction. Fires only when no
//   known slug substring is found — useful as a surface for new facilities
//   that should be added to the map (they'll show up as unknown_slug in the
//   audit log).

function extractEntries(html, source, knownSlugs) {
  const $ = cheerio.load(html);
  const entries = [];

  // Sort known slugs by length DESC so longest-match wins.
  // (Without this, "moncton-hospital" could match before "the-moncton-hospital".)
  const slugsByLen = [...new Set(knownSlugs || [])].sort((a, b) => b.length - a.length);

  const candidates = [
    '.views-row',
    'article.node, article.node-news',
    '.news-item, .news-teaser, .press-release',
    'article.post, article.type-post',
    'article[id^="post-"]',
    'article',
    '.post',
    '.entry',
  ];
  let postSel = null;
  for (const sel of candidates) {
    if ($(sel).length > 0) { postSel = sel; break; }
  }
  if (!postSel) return [];

  $(postSel).each((_, post) => {
    const $post = $(post);

    // Title
    const $title = $post.find(
      'h1.entry-title, h2.entry-title, h3.entry-title, ' +
      '.field--name-title, .views-field-title, .node-title, ' +
      'h1, h2, h3'
    ).first();
    const title = $title.text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    // Body
    const $content = $post.find(
      '.field--name-body, .field--name-field-body, ' +
      '.views-field-body, .node-body, ' +
      '.entry-content, .post-content, .content'
    ).first();
    const $bodySource = $content.length ? $content : $post;
    let body = '';
    $bodySource.find('p, li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length >= 15) body += (body ? '\n\n' : '') + t;
    });
    if (!body) return;

    // Closure-relevance filter — drop the noise (job postings, awards, etc.)
    if (!looksLikeClosurePost(title, body)) return;

    // Permalink + post date
    const permalink = $post.find(
      'h1 a, h2 a, h3 a, .entry-title a, .field--name-title a'
    ).first().attr('href') || null;
    const $time = $post.find('time, .entry-date, .post-date, .field--name-created').first();
    const postDate = $time.attr('datetime') || $time.text().trim() || null;

    // Facility identification — substring match against known slugs.
    // STRATEGY:
    //   1. Search the title first. The title is overwhelmingly more reliable
    //      for the primary subject (the closing facility) than the body,
    //      which often mentions ALTERNATIVE facilities patients should go to.
    //   2. Only fall back to body matching if no title slug is found —
    //      handles posts where the title is generic ("Service interruption")
    //      and the body names the facility.
    //   3. Within each scope, longest match wins (handles "the-moncton-hospital"
    //      vs "moncton-hospital" and similar overlaps).
    const titleSlug = slugify(title);
    const bodySlug  = slugify(body.slice(0, 400));

    let facility_hint = null;
    let facility_name = null;

    for (const slug of slugsByLen) {
      if (titleSlug.includes(slug)) {
        facility_hint = slug;
        facility_name = title;
        break;
      }
    }
    if (!facility_hint) {
      for (const slug of slugsByLen) {
        if (bodySlug.includes(slug)) {
          facility_hint = slug;
          facility_name = title;  // title still serves as display label
          break;
        }
      }
    }

    // Fallback: regex extraction. The slug will be unknown to the resolver,
    // generating an audit entry that surfaces facilities to add to the map.
    if (!facility_hint) {
      facility_name = facilityFromTitle(title);
      if (!facility_name) return;
      facility_hint = slugify(facility_name);
    }

    const service_label = inferService(title, body);
    const type_label = inferType(title, body);

    const body_hash = hashBody({
      source, facility_hint, service_label, body,
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
  name: 'nb_vitalite',
  province: 'NB',
  data_source: 'vitalite_nb',
  enabled: true,
  timezone: 'America/Moncton',

  async fetch(/* ctx */) {
    // Walk a few pages of the news index to capture recent posts.
    // Drupal Views pagination is typically ?page=N (0-indexed).
    const htmlPages = [];
    for (let p = 0; p < MAX_PAGES; p++) {
      const url = p === 0 ? BASE : `${BASE}?page=${p}`;
      try {
        const html = await fetchHtml(url);
        if (!html || html.length < 500) break;
        htmlPages.push(html);
      } catch (err) {
        // Pagination beyond available data may 404; stop walking.
        if (p === 0) throw err;
        break;
      }
    }
    return { url: BASE, htmlPages, pages: htmlPages.length };
  },

  parse(raw, ctx) {
    // Pull the known-slug list from the resolver so the parser can
    // substring-match titles against it. ctx.resolver is guaranteed to be
    // present (pipeline.js constructs it before calling parse).
    const knownSlugs = ctx?.resolver?.knownSlugs?.() || [];
    const entries = [];
    for (const html of raw.htmlPages) {
      entries.push(...extractEntries(html, 'vitalite_nb', knownSlugs));
    }
    return entries;
  },

  async resolveHospital(entry, ctx) {
    return ctx.resolver.lookupSlug(entry.facility_hint);
  },

  async scope(ctx) {
    return ctx.resolver.knownHospitalIds();
  },
};

// ------------------------------------------------------------
// CLI self-test: dump parsed entries from a saved HTML file
//   node providers/nb_vitalite.js /tmp/vitalite.html
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
    // Load known slugs from the config so substring matching works in CLI.
    const known_slugs = new Set();
    try {
      const cfg = require('../config/providers/nb_vitalite.json');
      for (const k of Object.keys(cfg)) {
        if (!k.startsWith('_')) known_slugs.add(k);
      }
    } catch {}
    const entries = extractEntries(html, 'vitalite_nb', [...known_slugs]);

    const summary = {
      entries_parsed: entries.length,
      slugs_seen:     [...new Set(entries.map(e => e.facility_hint))].sort(),
      slugs_unknown:  [...new Set(entries.map(e => e.facility_hint))].filter(s => !known_slugs.has(s)).sort(),
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
