#!/usr/bin/env node
// scrape.js
//
// Top-level scraper. Run every 5 min via cron on erstat-support LXC.
//
// Two kinds of providers:
//
//   1. CODE PROVIDERS — a JS module under providers/ that exports a full
//      provider interface. Use these for sources where parse-time
//      cleverness saves significant LLM cost (high cadence, complex
//      structure, etc.). Currently: ns_nshealth, nb_horizon, nb_vitalite.
//
//   2. LLM-EXTRACTED PROVIDERS — a config row in PROVINCIAL_PAGES below.
//      Just declare { name, province, data_source, url, ... } and the
//      universal extractor (lib/llm_page_extractor.js) handles fetch,
//      content-hash dedup, Haiku-based structured extraction, and
//      downstream pipeline integration. No HTML parsing code per source.
//
// ENVIRONMENT
//   PROVIDER=name           run only providers matching that name (comma-separated)
//   PROVINCE=NS,NB          run only providers whose province matches
//   SCRAPER_API_DEBUG=1     log api timings
//
// Adding a new province is now this:
//   1. Add a config row to PROVINCIAL_PAGES below (or flip enabled:true)
//   2. Create config/providers/{name}.json with the facility slug map
//   3. Done. Cron picks it up on the next tick.

const { runProvider }     = require('./lib/pipeline');
const { makeLlmProvider, makeLlmListProvider } = require('./lib/llm_page_extractor');

// ============================================================
// CODE PROVIDERS
// Per-source HTML parsers that earn their keep on cadence or complexity.
// ============================================================
const CODE_PROVIDERS = [
  require('./providers/ns_nshealth'),         // high cadence, complex Drupal Views, parser is cheaper than LLM
  require('./providers/nb_horizon'),          // table-banner WordPress layout, parser handles weird structure
  require('./providers/bc_northernhealth'),   // structured HTML table, no LLM needed — zero per-pass cost
];

// ============================================================
// LIST PROVIDERS (RSS / HTML index → per-article LLM extraction)
// Each item gets one Haiku call EVER. Cache by URL keeps cost flat.
// ============================================================
const PROVINCIAL_LISTS = [
  // Vitalité Health Network (NB francophone). Closures, restrictions and
  // service changes are each published as a separate "Public Notice" article.
  // The RSS feed gives a clean stream of items; we LLM-extract each new URL
  // exactly once, then trust the closure_event for time-window persistence.
  {
    name:         'nb_vitalite',
    province:     'NB',
    data_source:  'vitalite_nb',
    rss_url:      'https://vitalitenb.ca/en/health-network/communications/public-notices?format=feed&type=rss',
    source_label: 'Vitalité Public Notices',
    timezone:     'America/Moncton',
    max_items:    15,
    enabled:      true,
  },

  // Saskatchewan Health Authority — index page lists current emergency
  // service disruptions as community links; each community has a subpage
  // with the actual facility name and disruption details.
  //
  // Cadence: twice-daily at 9:00 AM and 4:00 PM (announced 2026-04-30,
  // active from 2026-05-19). Plus ad-hoc updates as new disruptions occur.
  //
  // No RSS feed; we parse the HTML index for community-specific links of
  // the form /news-events/service-disruptions/{community-slug} and skip
  // the index URL itself.
  //
  // The URL pattern makes the community slug the most reliable signal —
  // ideal for our city-fallback resolver. Each Haiku call extracts the
  // facility name from the subpage, and even if we don't have a slug
  // alias for that facility, the city ("kamsack" → "Kamsack") resolves
  // to the single SK ER hospital in that town.
  {
    name:         'sk_sha',
    province:     'SK',
    data_source:  'sha_disruptions',
    list_url:     'https://www.saskhealthauthority.ca/news-events/service-disruptions',
    list_extract: function($, indexUrl) {
      const seen = new Set();
      const items = [];
      $('a[href*="/news-events/service-disruptions/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        // Match community-specific subpages, exclude the index itself
        const m = href.match(/\/news-events\/service-disruptions\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/i);
        if (!m) return;
        const slug = m[1];
        // Skip any non-community paths (defensive — there shouldn't be any)
        if (slug.length < 2) return;
        try {
          const absUrl = new URL(href, indexUrl).toString().split('#')[0].replace(/\/$/, '');
          if (seen.has(absUrl)) return;
          seen.add(absUrl);
          items.push({
            url: absUrl,
            title: ($(el).text() || slug).trim(),
            pub_date: null,
            description: null,
          });
        } catch (_) { /* ignore malformed URLs */ }
      });
      return items;
    },
    source_label: 'SHA Service Disruptions',
    timezone:     'America/Regina',
    max_items:    25,
    enabled:      true,
  },



  // Health PEI — alerts published on the provincial government site as
  // individual /en/alert/ articles. The main site is behind Cloudflare WAF
  // and 403s our fetches, but the low-bandwidth `lite.princeedwardisland.ca`
  // mirror is reachable and lists all recent alerts in a clean HTML list.
  //
  // Format on the lite homepage's "Latest News and Alerts" section:
  //   <li><a href="...">Title</a> | Category | Date</li>
  //
  // We filter to Category=Health, which captures ED closures
  // ("KCMH Emergency Department Closing Early", "Western Hospital ED")
  // and ignores Traffic / News Release / etc. The classifier handles
  // non-closure Health items (outbreak declarations, etc.) by emitting
  // is_closure=false.
  //
  // Cadence: PE closures are sporadic. Most passes will yield 0-1 Health
  // items. LLM cost ~$0.0001/pass = ~$10/year.
  //
  // Five PE ER facilities tracked: QEH (Charlottetown), Prince County
  // (Summerside), Kings County Memorial (Montague), Western Hospital
  // (Alberton), Souris Hospital. Souris isn't on the gov wait-time tracker
  // but is included here for closure visibility.
  {
    name:         'pe_healthpei',
    province:     'PE',
    data_source:  'healthpei_alerts',
    list_url:     'https://lite.princeedwardisland.ca/',
    list_extract: function($, indexUrl) {
      const seen = new Set();
      const items = [];
      // List items contain "[Title](URL) | Category | Date" in markdown.
      // In HTML each is an <li> with an <a> followed by " | Category | Date" text.
      $('li').each((_, el) => {
        const $el = $(el);
        const fullText = $el.text();
        // Only Health category items. The pipe-separated text after the
        // link reveals the category. Matches: " | Health | "
        if (!/\|\s*Health\s*\|/i.test(fullText)) return;
        const $a = $el.find('a').first();
        const href = $a.attr('href');
        if (!href) return;
        const title = ($a.text() || '').trim();
        if (!title) return;
        try {
          const absUrl = new URL(href, indexUrl).toString().split('#')[0].replace(/\/$/, '');
          if (seen.has(absUrl)) return;
          seen.add(absUrl);
          items.push({
            url:         absUrl,
            title,
            pub_date:    null,
            description: null,
          });
        } catch (_) { /* ignore malformed URLs */ }
      });
      return items;
    },
    source_label: 'Health PEI Alerts',
    timezone:     'America/Halifax',
    max_items:    10,
    enabled:      true,
  },
];



// ============================================================
// SINGLE-PAGE LLM PROVIDERS (one URL → one Haiku call when page changes)
// For sources where all current closures live on one consolidated page.
// ============================================================
const PROVINCIAL_PAGES = [
  // Alberta Health Services — "AHS Facilities: Temporary Service Disruptions"
  // page lists each Alberta facility with currently-reduced services (ED on
  // diversion, obstetrics closed, etc.) with start/end dates and reasons.
  //
  // Cadence: explicitly updated Tuesdays & Fridays at 5pm. So ~2 page edits/
  // week. Filesystem-backed page cache (lib/llm_page_extractor.js) means we
  // only call Haiku when content_hash changes — ~2 LLM calls/week ≈ $1/year.
  //
  // The page covers all of Alberta; AHS facility names sometimes differ from
  // D1 canonical names (e.g. "Myron Thompson Health Centre" = Sundre Hospital).
  // See config/providers/ab_ahs.json for the alias map.
  {
    name:         'ab_ahs',
    province:     'AB',
    data_source:  'ahs_bed_space',
    url:          'https://www.albertahealthservices.ca/br/Page17594.aspx',
    source_label: 'AHS Temporary Service Disruptions',
    timezone:     'America/Edmonton',
    enabled:      true,
  },

  // Newfoundland and Labrador Health Services — single consolidated page
  // with H3 sections per active disruption. Each section names one or
  // more facilities, the disruption type, and the time window.
  //
  // Cadence: ad hoc — page is updated as new closures/Virtual ER coverage
  // is announced, and entries are removed when service resumes.
  //
  // NL distinguishes:
  //   - Temporary Closure (full ED shutdown)
  //   - Virtual ER (ED open with virtual physician — emit as is_closure
  //     with scope=partial_service so the user sees a reduced-service
  //     warning rather than a fully-open ED)
  //   - Disruption (specific service like x-ray/lab unavailable; ED open)
  //   - Visitor Precaution (not service-affecting; LLM should emit
  //     is_closure=false)
  //
  // Some notices group multiple facilities under one section (e.g. Central
  // Zone Virtual ER covering 5 sites). The page-extractor prompt's rule 6
  // tells Haiku to emit one entry per named area.
  {
    name:         'nl_nlhs',
    province:     'NL',
    data_source:  'nlhs_updates',
    url:          'https://nlhealthservices.ca/service-updates/',
    source_label: 'NL Health Services Updates',
    timezone:     'America/St_Johns',
    enabled:      true,
  },

  // Northwest Territories Health and Social Services Authority
  {
    name:         'nt_nthssa',
    province:     'NT',
    data_source:  'nthssa_notices',
    url:          'https://www.nthssa.ca/en/newsroom',
    source_label: 'NTHSSA Notices',
    timezone:     'America/Yellowknife',
    enabled:      false,
  },
];

// ============================================================
// Build the final provider list
// ============================================================
const LIST_PROVIDERS = PROVINCIAL_LISTS
  .filter(cfg => cfg.enabled !== false)
  .map(cfg => makeLlmListProvider(cfg));

const LLM_PROVIDERS = PROVINCIAL_PAGES
  .filter(cfg => cfg.enabled !== false)
  .map(cfg => makeLlmProvider(cfg));

const ALL_PROVIDERS = [...CODE_PROVIDERS, ...LIST_PROVIDERS, ...LLM_PROVIDERS];

function selectProviders() {
  let pool = ALL_PROVIDERS.filter(p => p.enabled !== false);

  if (process.env.PROVIDER) {
    const wanted = new Set(process.env.PROVIDER.split(',').map(s => s.trim()));
    pool = pool.filter(p => wanted.has(p.name));
  }
  if (process.env.PROVINCE) {
    const wanted = new Set(
      process.env.PROVINCE.split(',').map(s => s.trim().toUpperCase())
    );
    pool = pool.filter(p => wanted.has(p.province));
  }
  return pool;
}

async function main() {
  const providers = selectProviders();
  if (providers.length === 0) {
    console.error(`[scrape] no providers selected (PROVIDER=${process.env.PROVIDER || '(unset)'}, PROVINCE=${process.env.PROVINCE || '(unset)'})`);
    process.exit(1);
  }

  let anySuccess = false;

  for (const provider of providers) {
    let result;
    try {
      result = await runProvider(provider);
    } catch (err) {
      result = {
        ok: false,
        stage: 'unhandled',
        provider: provider.name,
        error: err.stack || err.message,
      };
    }
    if (result.ok) anySuccess = true;
    console.log(JSON.stringify(result));
  }

  process.exit(anySuccess ? 0 : 1);
}

main().catch((err) => {
  console.error(`[scrape] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
