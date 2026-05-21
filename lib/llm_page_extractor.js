// lib/llm_page_extractor.js
//
// Universal page → closure extractor. Replaces per-source HTML parsers
// for sources where the layout is too irregular or low-cadence to justify
// writing dedicated code.
//
// HOW IT WORKS
//   1. Fetch the page via curl-impersonate (Cloudflare bypass)
//   2. Strip nav / footer / scripts / styles to keep only visible content
//   3. SHA-256 the cleaned content. Look it up in source_classifications
//      by (data_source, body_hash). If we have a cached extraction, return it.
//   4. Cache miss → send the cleaned content to Haiku 4.5 with a structured
//      prompt asking for a JSON array of closure entries
//   5. Parse, validate, return entries shaped for the pipeline
//
// COST PROFILE
//   Page hashes change only when the visible content meaningfully changes,
//   so the LLM is called once per real edit. At typical cadences this works
//   out to roughly $1-15/year per source. Hash-based deduping does most of
//   the work; the LLM does the structural intelligence.
//
// USAGE — building a provider becomes 4 lines:
//
//   module.exports = makeLlmProvider({
//     name: 'sk_sha',
//     province: 'SK',
//     data_source: 'sha_disruptions',
//     url: 'https://www.saskhealthauthority.ca/.../disruptions',
//     timezone: 'America/Regina',
//   });

const cheerio = require('cheerio');
const crypto  = require('node:crypto');
const fs      = require('node:fs/promises');
const path    = require('node:path');
const { fetchHtml } = require('./fetch');
const { hash }      = require('./hash');

// ------------------------------------------------------------
// FileSystemPageCache — persistent content-hash → result cache
// ------------------------------------------------------------
//
// Used by single-page providers (makeLlmProvider) to avoid re-calling Haiku
// on every cron pass when the source page hasn't changed. The page is fetched
// every pass (cheap), but the LLM call is skipped when content_hash matches a
// previously-extracted result.
//
// Layout:
//   {dir}/{content_hash}.json   — one file per unique page content_hash
//
// Files never explicitly expire. They're small (~1-50KB) so accumulating
// hundreds over a year is fine. If needed, prune by mtime via cron.
//
// Note: this caches the LLM EXTRACTION (page → entries[]). The pipeline's
// per-entry source_classifications cache handles the SECOND layer (entries →
// regex+LLM classification). For pre-classified entries from this provider,
// the pipeline lookup is bypassed entirely because entries arrive with .llm
// populated. So this disk cache is the only thing standing between us and
// 288 Haiku calls/day per single-page source.

class FileSystemPageCache {
  constructor(dir) {
    this.dir = dir;
  }

  async get(content_hash) {
    try {
      const data = await fs.readFile(path.join(this.dir, `${content_hash}.json`), 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      // ENOENT → cache miss, expected; anything else → log and treat as miss
      if (err && err.code !== 'ENOENT') {
        console.error(`[FileSystemPageCache] read failed for ${content_hash}: ${err.message}`);
      }
      return null;
    }
  }

  async set(content_hash, result) {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(
        path.join(this.dir, `${content_hash}.json`),
        JSON.stringify(result),
      );
    } catch (err) {
      console.error(`[FileSystemPageCache] write failed for ${content_hash}: ${err.message}`);
      throw err;
    }
  }
}

// ------------------------------------------------------------
// Content extraction — strip everything that isn't reading-content
// ------------------------------------------------------------
//
// We want roughly what a reader-mode browser would show: the article body
// minus nav / footer / scripts / styles / boilerplate. Two passes:
//   1. Drop unambiguously-non-content tags
//   2. Drop common nav/footer/sidebar containers by class/id pattern

function extractVisibleContent(html) {
  const $ = cheerio.load(html);

  // Hard drops — these never contain content we care about
  $('script, style, noscript, iframe, link, meta, svg').remove();
  $('nav, header, footer, aside').remove();

  // Common boilerplate containers by class/id pattern
  $([
    '.menu, .navbar, .navigation, .nav-bar',
    '.sidebar, .widget, .widgets',
    '.footer, .site-footer, .page-footer',
    '.header, .site-header, .page-header',
    '.breadcrumb, .breadcrumbs',
    '.search-bar, .search-form',
    '.social-icons, .social-links, .share',
    '.cookie, .cookie-notice, .cookie-banner',
    '.skip-link, .screen-reader-text, .sr-only',
    '#wrapper-navbar, #site-navigation, #colophon',
    '[class*="related"], [class*="comments"]',
  ].join(', ')).remove();

  // Prefer an article / main / .entry-content / .content if present —
  // strips chrome that survived the above. Fall back to <body>.
  const candidates = [
    'article',
    'main',
    '.entry-content',
    '.page-content',
    '.post-content',
    '.content-area',
    '.main-content',
    '#content',
    '#main',
    'body',
  ];
  let $root = null;
  for (const sel of candidates) {
    const $found = $(sel).first();
    if ($found.length && $found.text().trim().length > 100) {
      $root = $found;
      break;
    }
  }
  if (!$root) $root = $('body');

  // Collapse to plain text. Preserve paragraph breaks; HTML structure is
  // signal-poor at this stage and adds tokens.
  let text = '';
  $root.find('h1, h2, h3, h4, h5, h6, p, li, td, dd, dt').each((_, el) => {
    const t = $(el).text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 5) text += t + '\n';
  });
  if (!text.trim()) {
    // Fallback: raw text of the root if structured walk produced nothing
    text = $root.text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Final cleanup: collapse runs of blank lines, trim
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------
// LLM extraction
// ------------------------------------------------------------

const ANTHROPIC_MODEL = process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildExtractionPrompt(opts) {
  const { province, today, source_label, timezone, offset } = opts;
  return `You are extracting hospital and clinic service-closure information from a Canadian provincial health-authority webpage.

Context:
- Province: ${province}
- Source: ${source_label}
- Today's date (in ${timezone || 'America/Halifax'}): ${today}
- Current timezone offset for this province: ${offset || '-03:00'}

Your task: read the page content and output a JSON array of closure/disruption entries. One object per facility-and-service combination.

For each entry, output the following fields:

{
  "facility_name":     "<exact name as written on the page, including French diacritics if present>",
  "city":              "<the city or town this facility is located in, taken from the page if explicitly stated (e.g. a 'City / Town' column or a city heading near the entry), or null if not stated>",
  "service":           "<e.g. Emergency Department, Obstetrics, Surgery, Laboratory, Diagnostic Imaging, Pediatrics, Mental Health, Primary Care, Urgent Treatment Centre>",
  "type":              "<one of: Disruption, Advisory, Reopening, Reduced Hours, Scheduled>",
  "is_closure":        true | false,
  "scope":             "<full | partial_hours | partial_service | reduced | none>",
  "closed_from":       "<ISO 8601 with timezone offset, or null if open-ended/unknown>",
  "closed_until":      "<ISO 8601 with timezone offset, or null if open-ended/unknown>",
  "reopen_phrase":     "<verbatim phrase from the body indicating when service resumes, or null>",
  "body_excerpt":      "<1-3 closure-specific sentences: facility, hours, scope, dates. NO generic emergency boilerplate. Max 400 chars.>",
  "confidence":        "high | medium | low",
  "reasoning":         "<one-sentence justification of is_closure and scope, citing specific phrases>"
}

CRITICAL RULES

1. is_closure means "this entry describes a closure event" (past, present, or future). It does NOT depend on whether the closure is currently active — that's computed downstream from closed_from / closed_until.

2. If a date range is given in local provincial time (e.g. "8 p.m. Saturday, May 17 until 8 a.m. Monday, May 19"), express closed_from and closed_until as ISO 8601 with the offset ${offset || '-03:00'} (the current offset for ${timezone || 'America/Halifax'}). Example: "2026-05-20T23:59:00${offset || '-03:00'}". Today is ${today}; infer the year from context if a year isn't stated. If a closure window plausibly crosses a DST transition, use the offset that applies to the start time and note the crossing in reasoning.

3. If the closure is open-ended or until further notice, set closed_until to null.

4. Skip entries that are purely informational (no facility-specific service change). Skip recruitment notices, awards, generic public-health messages.

5. ERstat tracks Emergency Department status only. For service disruptions that do NOT affect the Emergency Department (obstetrics, surgery, laboratory, diagnostic imaging, pharmacy, mental health, physiotherapy, primary care, dialysis, etc.) where the ED itself remains operational, set is_closure=false. Still emit the entry so the advisory data is preserved, but is_closure must be false. Set is_closure=true ONLY when the ED is materially affected — full closure, diversion, reduced hours, suspended walk-in, or operating with virtual physician coverage only. The "service" field should reflect what the article actually says about the disruption (e.g. "Obstetrics" if obstetrics is closed); is_closure is the toggle that determines whether this counts as an ED-level event.

6. Distinguishing scope='full' from scope='partial_hours' when is_closure=true:
   - Use scope='partial_hours' whenever the entry describes a SCHEDULE — i.e., when the ED IS open at certain hours/days even if "closed" appears prominently. Indicators: phrases like "Regular operating hours are...", "Open Mondays 0800-2000", "Closed Fridays-Sundays", "closed from 2100-0900 daily", any recurring open/close pattern.
   - Use scope='full' only when the ED is unavailable for a discrete window with no operating schedule during it. Examples: "temporarily closed until further notice", "closed May 20 4pm to May 20 11:59pm", "unplanned closure today, reopening tomorrow morning".
   - "Emergency department closed, regular hours are Mon-Thu 9-5" → partial_hours (schedule present, even though 'closed' is the lead verb).
   - "Emergency department temporarily closed, no estimated reopen time" → full (no schedule given).

7. body_excerpt content rules:
   - Include ONLY closure-specific facts: which facility, which service, what hours/dates, what scope (reduced hours, full closure, etc.), what the reason is if stated.
   - EXCLUDE generic boilerplate that appears on every disruption article: "Call 911 in the event of an emergency", "Paramedics will assess, treat, and transport...", "Healthline 811", "Visit the Facilities and Locations page...", "Service availability can change on short notice...". These add no information to the closure card and crowd out the useful content.
   - Aim for 1-3 short sentences. The body_excerpt appears as the primary text on the closure card; users scan it for actionable info (when, where, how long), not safety instructions they already know.

8. If the page contains a cross-facility service notice (e.g. "Physiotherapy shortage in Moncton, Saint John, and Miramichi"), emit ONE entry per named area with facility_name = the area name as-given. Mark scope as "reduced" if appointments are merely affected, "partial_service" if some appointments are cancelled.

9. If the page genuinely lists no current closures (e.g. an empty "Current closures" section, or a "no current notices" placeholder), return an empty array: [].

10. Output ONLY the JSON array. No prose, no markdown fences, no commentary. The response must begin with [ and end with ].

PAGE CONTENT:

${opts.content}`;
}

async function callAnthropic(prompt, opts = {}) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const max_tokens = opts.max_tokens || 4096;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, usage: json.usage, model: json.model, stop_reason: json.stop_reason };
}

// Robust JSON parse — handles models that wrap output in ```json fences
// despite being told not to, prepend a tiny preamble, or get truncated by
// max_tokens. Truncation-tolerant: if the closing `]` is missing, we
// extract complete objects up to that point and rebuild a valid array.
function parseEntries(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = t.indexOf('[');
  if (first === -1) {
    throw new Error(`LLM output contained no JSON array; text_len=${text.length}, preview="${text.slice(0, 120)}..."`);
  }
  const last = t.lastIndexOf(']');

  // Happy path: full array
  if (last > first) {
    try {
      const parsed = JSON.parse(t.slice(first, last + 1));
      if (!Array.isArray(parsed)) throw new Error('LLM output was not an array');
      return parsed;
    } catch (err) {
      // Fall through to truncation recovery
      console.error(`[llm_page_extractor] full-array parse failed (${err.message}); trying truncation recovery`);
    }
  }

  // Truncation recovery: scan from `[`, collect balanced top-level objects,
  // stop at the first failed parse, and return what we got.
  const recovered = [];
  let i = first + 1;
  while (i < t.length) {
    while (i < t.length && t[i] !== '{') i++;
    if (i >= t.length) break;

    // Find matching closing brace by counting depth, respecting strings
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let objEnd = -1;
    for (let j = objStart; j < t.length; j++) {
      const ch = t[j];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = j; break; }
      }
    }
    if (objEnd === -1) break; // truncated mid-object

    try {
      recovered.push(JSON.parse(t.slice(objStart, objEnd + 1)));
    } catch (_) {
      break;
    }
    i = objEnd + 1;
  }

  if (recovered.length === 0) {
    throw new Error(`LLM output contained no JSON array; text_len=${text.length}, preview="${text.slice(0, 120)}..."`);
  }
  console.error(`[llm_page_extractor] recovered ${recovered.length} entries from truncated/malformed output (text_len=${text.length})`);
  return recovered;
}

// ------------------------------------------------------------
// Slug resolution for the parsed entries
// ------------------------------------------------------------
//
// The LLM returns facility names verbatim from the page. We need to map
// each to an ERstat hospital_id. Three strategies, in order:
//
//   1. Slugify the facility_name and look it up in the provider's slug
//      map (config/providers/{name}.json). Handles cases where the slug
//      map already covers a facility variant.
//
//   2. Substring-match the slugified name against the known slug list.
//      Handles "the Sussex Health Centre", "Sussex Health Centre ED",
//      and similar variations without needing every variant in the map.
//
//   3. City fallback: if the LLM also extracted a city, look that city
//      up in the provider's `_city_to_id` map. Used when AHS calls a
//      facility by a completely different formal name ("Myron Thompson
//      Health Centre" in Sundre) than D1 ("Sundre Hospital & Care
//      Centre"). The city map only includes cities with exactly ONE ER
//      hospital — multi-hospital cities like Calgary fall through and
//      stay as unknown_slug (you don't want to silently pick one
//      Calgary hospital when AHS named a different one we don't know).

function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''ʼ`'']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveFacility(facility_name, resolver, city) {
  const slug = slugify(facility_name);
  const direct = resolver.lookupSlug(slug);
  if (direct) return { facility_hint: slug, hospital_id: direct, via: 'slug-direct' };

  // Substring match — longest known slug that appears in our slug wins
  const known = resolver.knownSlugs().sort((a, b) => b.length - a.length);
  for (const k of known) {
    if (slug.includes(k)) return { facility_hint: k, hospital_id: resolver.lookupSlug(k), via: 'slug-substring' };
  }
  // Or our slug contains a known slug as substring
  for (const k of known) {
    if (k.includes(slug) && slug.length >= 6) {
      return { facility_hint: k, hospital_id: resolver.lookupSlug(k), via: 'slug-reverse' };
    }
  }

  // City fallback. Only fires when:
  //   (a) the LLM extracted a city for this entry,
  //   (b) the resolver supports city lookup,
  //   (c) that city has exactly one ER hospital in our map.
  if (city && typeof resolver.lookupCity === 'function') {
    const citySlug = slugify(city);
    const cityHit = resolver.lookupCity(citySlug);
    if (cityHit) {
      return { facility_hint: slug, hospital_id: cityHit, via: 'city-fallback', matched_city: citySlug };
    }
  }

  return { facility_hint: slug, hospital_id: null, via: 'unresolved' };
}

// ------------------------------------------------------------
// Public API: extract closures from a page URL
// ------------------------------------------------------------

/**
 * Fetch a page, dedup by content hash, ask Haiku to extract closure entries.
 *
 * @param {Object} opts
 * @param {string} opts.url                    Page URL
 * @param {string} opts.province               ISO province code (NS, NB, etc.)
 * @param {string} opts.data_source            Provider data_source tag for cache key
 * @param {string} opts.source_label           Human-readable name for prompt context
 * @param {string} opts.timezone               IANA tz, e.g. 'America/Halifax'
 * @param {Object} opts.cache                  Optional cache lookup:
 *                                                { get(hash), set(hash, result) }
 *                                                If omitted, every call hits Haiku.
 * @returns {Promise<{
 *   content_hash: string,
 *   from_cache: boolean,
 *   page_size: number,
 *   llm_usage: object | null,
 *   raw_entries: Array<LlmEntry>,
 * }>}
 */
async function extractFromPage(opts) {
  const t0 = Date.now();
  const html = await fetchHtml(opts.url);
  const content = extractVisibleContent(html);
  const content_hash = hash(opts.data_source, content);

  if (opts.cache) {
    const cached = await opts.cache.get(content_hash);
    if (cached) {
      return {
        content_hash,
        from_cache: true,
        page_size: content.length,
        llm_usage: null,
        raw_entries: cached.raw_entries || [],
        elapsed_ms: Date.now() - t0,
      };
    }
  }

  const timezone = opts.timezone || 'America/Halifax';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const offset = getTzOffset(timezone) || '-03:00';

  const prompt = buildExtractionPrompt({
    province: opts.province,
    today,
    timezone,
    offset,
    source_label: opts.source_label || opts.data_source,
    content,
  });

  // 16384 tokens lets ~30 entries fit, each with full body_excerpt up to
  // 600 chars + structured fields. AHS lists at most 20-25 facilities at
  // once today; if a province ever exceeds this we'll see truncation and
  // raise the cap further.
  const { text, usage, model, stop_reason } = await callAnthropic(prompt, { max_tokens: 16384 });
  if (stop_reason === 'max_tokens') {
    console.error(`[llm_page_extractor] WARNING: ${opts.data_source} hit max_tokens — output may be truncated, parser will recover what it can`);
  }
  let raw_entries;
  try {
    raw_entries = parseEntries(text);
  } catch (err) {
    throw new Error(`LLM extraction parse failed: ${err.message}; stop_reason=${stop_reason}; text_len=${text.length}; raw_head=${text.slice(0, 200).replace(/\n/g, '\\n')}; raw_tail=${text.slice(-200).replace(/\n/g, '\\n')}`);
  }

  const result = {
    content_hash,
    from_cache: false,
    page_size: content.length,
    llm_usage: usage,
    llm_model: model,
    raw_entries,
    elapsed_ms: Date.now() - t0,
  };

  if (opts.cache) {
    try {
      await opts.cache.set(content_hash, result);
    } catch (err) {
      console.error(`[llm_page_extractor] cache.set failed (non-fatal): ${err.message}`);
    }
  }

  return result;
}

// ------------------------------------------------------------
// Provider factory — turns a small config into a full provider module
// ------------------------------------------------------------
//
// Used in scrape.js like:
//
//   require('./providers/llm/ab_ahs')   // tiny file that calls makeLlmProvider
//
// or registered directly in scrape.js by importing this and listing config
// objects. The CONFIG-DRIVEN approach is preferred — see scrape.js for the
// PROVINCIAL_PAGES registry.

function makeLlmProvider(config) {
  const required = ['name', 'province', 'data_source', 'url'];
  for (const k of required) {
    if (!config[k]) throw new Error(`makeLlmProvider: missing required config.${k}`);
  }

  // Auto-instantiate a filesystem-backed page-content cache. This is what
  // makes single-page providers economical: the page is fetched every pass
  // (cheap, ~50ms), but the LLM call is skipped when content_hash matches.
  // Override-able via config.cache_dir for tests or alternate locations.
  const cacheDir = config.cache_dir || `/var/cache/erstat-scraper/${config.data_source}`;
  const pageCache = new FileSystemPageCache(cacheDir);

  return {
    name:         config.name,
    province:     config.province,
    data_source:  config.data_source,
    enabled:      config.enabled !== false,
    timezone:     config.timezone || 'America/Halifax',

    async fetch(/* ctx */) {
      // Defer the actual work to parse() — extraction is one HTTP fetch
      // plus one LLM call, and we want both to happen inside the timed
      // section where pipeline.js can attribute failures correctly.
      return { url: config.url };
    },

    async parse(raw, ctx) {
      // The pipeline's classify step gets short-circuited for LLM providers:
      // the LLM call is the parse. We emit pre-classified ParsedEntries with
      // .llm already populated, and the pipeline's "cache miss → call LLM"
      // path is bypassed by the .llm field being non-null.
      const result = await extractFromPage({
        url:          config.url,
        province:     config.province,
        data_source:  config.data_source,
        source_label: config.source_label || config.name,
        timezone:     config.timezone,
        cache:        pageCache,
      });

      // Map raw LLM entries to ParsedEntry shape.
      const entries = [];
      for (const e of (result.raw_entries || [])) {
        if (!e || !e.facility_name) continue;

        const facility_name = String(e.facility_name).trim();
        const facility_hint = slugify(facility_name);
        const service_label = e.service || 'Emergency Department';
        const body          = String(e.body_excerpt || '').slice(0, 2000);
        if (!body) continue;

        const body_hash = hash(
          config.data_source,
          facility_hint,
          service_label,
          body,
        );

        entries.push({
          source_record_id: null,
          facility_name,
          facility_hint,
          city:           e.city ? String(e.city).trim() : null,
          service_label,
          body,
          body_hash,
          type_label: e.type || 'Disruption',
          subject_kind: 'facility',
          zone: null,
          location: null,
          metadata: {
            content_hash:  result.content_hash,
            from_cache:    result.from_cache,
            llm_model:     result.llm_model,
            llm_usage:     result.llm_usage,
            source_url:    config.url,
          },
          // Pre-classified: skips the pipeline's regex+LLM step.
          llm: {
            is_closure:    Boolean(e.is_closure),
            scope:         e.scope || null,
            closed_from:   e.closed_from || null,
            closed_until:  e.closed_until || null,
            reopen_phrase: e.reopen_phrase || null,
            confidence:    e.confidence || null,
            reasoning:     e.reasoning || null,
            model:         result.llm_model || null,
          },
        });
      }
      return entries;
    },

    async resolveHospital(entry, ctx) {
      const r = resolveFacility(entry.facility_name, ctx.resolver, entry.city);
      // Update the entry's facility_hint to the slug we actually resolved
      // against, so the resolver and audit log report the matched slug
      // rather than the raw LLM-output slug.
      if (r.facility_hint && r.facility_hint !== entry.facility_hint) {
        entry.facility_hint = r.facility_hint;
      }
      // Stash resolution method on metadata for audit visibility
      entry.metadata = { ...(entry.metadata || {}), resolved_via: r.via };
      if (r.matched_city) entry.metadata.matched_city = r.matched_city;
      return r.hospital_id;
    },

    async scope(ctx) {
      return ctx.resolver.knownHospitalIds();
    },
  };
}

// ============================================================
// RSS / Atom feed parsing
// ============================================================

function parseRssFeed(xmlString) {
  const $ = cheerio.load(xmlString, { xmlMode: true });
  const items = [];

  // RSS 2.0
  $('item').each((_, el) => {
    const $item = $(el);
    const url = ($item.find('link').first().text() || $item.find('guid').first().text() || '').trim();
    const title = $item.find('title').first().text().trim();
    const pubDate = ($item.find('pubDate').first().text() || '').trim();
    const description = $item.find('description').first().text().trim();
    if (url && title) items.push({ url, title, pub_date: pubDate || null, description: description || null });
  });

  // Atom fallback
  if (items.length === 0) {
    $('entry').each((_, el) => {
      const $item = $(el);
      const url = $item.find('link').first().attr('href') || '';
      const title = $item.find('title').first().text().trim();
      const pubDate = ($item.find('published').first().text() || $item.find('updated').first().text() || '').trim();
      const description = ($item.find('summary').first().text() || $item.find('content').first().text() || '').trim();
      if (url && title) items.push({ url, title, pub_date: pubDate || null, description: description || null });
    });
  }

  return items;
}

// ============================================================
// Per-article LLM extraction
// ============================================================
//
// Used by makeLlmListProvider: each article URL is sent to Haiku once
// with the article content, and we get back a structured closure verdict
// (or "this isn't a closure" for non-closure articles).

function buildArticlePrompt(opts) {
  const { content, title, url, province, today, source_label, timezone, offset } = opts;
  return `You are reading a single article from a Canadian provincial health authority's website. The article may or may not be about a service closure or disruption at a healthcare facility. Decide which, and if it IS a closure, extract structured details.

Context:
- Province: ${province}
- Source: ${source_label}
- Article URL: ${url}
- Article title: ${title}
- Today's date (in ${timezone || 'America/Halifax'}): ${today}
- Current timezone offset for this province: ${offset || '-03:00'}

Output a JSON object with this exact shape:

{
  "is_closure":        true | false,
  "facility_name":     "<exact name from the article, including French diacritics, or null>",
  "city":              "<city or town this facility is located in, taken from the article if stated (or inferable from the facility name like 'Edmundston Public Health Office'), else null>",
  "service":           "<e.g. Emergency Department, Obstetrics, Surgery, Laboratory, Diagnostic Imaging, Mental Health, Public Health, Primary Care, Pharmacy>",
  "type":              "Disruption" | "Advisory" | "Reopening" | "Reduced Hours" | "Scheduled",
  "scope":             "full" | "partial_hours" | "partial_service" | "reduced" | "none",
  "closed_from":       "<ISO 8601 with timezone offset, or null>",
  "closed_until":      "<ISO 8601 with timezone offset, or null>",
  "reopen_phrase":     "<verbatim phrase indicating when service resumes, or null>",
  "body_excerpt": "<1-3 closure-specific sentences: facility, hours, scope, dates. NO generic emergency boilerplate. Max 400 chars.>",
  "confidence":        "high" | "medium" | "low",
  "reasoning":         "<one-sentence justification>"
}

RULES

1. is_closure = true only if the article describes a temporary or scheduled closure, suspension, reduction, or unavailability of a specific healthcare service at a specific facility.

2. is_closure = false for: recruitment, technology changes (telephone, software, EMR), administrative news, awards, quarterly reports, calls for interest, board meetings, general public-health messaging, governance updates.

3. Visitor restrictions in a specific ward: is_closure = true ONLY if the article says the SERVICE being provided to patients is reduced or suspended. Pure visitor-policy changes that don't affect service delivery → is_closure = false.

4. Reopening announcements ("ED is back open" / "Service has resumed") → is_closure = false (the closure is OVER, not currently active). Set type = "Reopening" so the pipeline can match against prior closure events.

5. ERstat tracks Emergency Department status only. If the article describes a disruption to a service other than the ED (obstetrics, surgery, laboratory, diagnostic imaging, pharmacy, mental health, primary care, etc.) AND the ED itself remains operational, set is_closure=false. Set is_closure=true ONLY when the ED is materially affected — full closure, diversion, reduced hours, suspended walk-in, or operating with virtual physician coverage only. Record what the article says about the disruption in "service" regardless of is_closure; is_closure is the toggle that decides whether this is an ED-level event.

6. Times: The article describes events in ${timezone || 'America/Halifax'}. The current local offset there is ${offset || '-03:00'}. Today's local date is ${today}. Express closed_from and closed_until as ISO 8601 with the offset ${offset || '-03:00'} (e.g. "2026-05-20T23:59:00${offset || '-03:00'}"). If the article gives only a date with no time, use the most reasonable boundary (closure starts at 00:00, closure ends at 23:59 of stated day) and note that in reasoning. If a closure window plausibly crosses a DST transition, use the offset that applies to the start time and note the crossing in reasoning.

7. body_excerpt content rules:
   - Include ONLY closure-specific facts: which facility, which service, what hours/dates, what scope (reduced hours, full closure, etc.), what the reason is if stated.
   - EXCLUDE generic boilerplate that appears on every disruption article: "Call 911 in the event of an emergency", "Paramedics will assess, treat, and transport...", "Healthline 811", "Visit the Facilities and Locations page...", "Service availability can change on short notice...". These add no information to the closure card and crowd out the useful content.
   - Aim for 1-3 short sentences. The body_excerpt appears as the primary text on the closure card; users scan it for actionable info (when, where, how long), not safety instructions they already know.

8. Output ONLY the JSON object. No prose, no markdown fences. Begin with { and end with }.

ARTICLE CONTENT:

${content}`;
}

// Compute the current UTC offset (e.g. "-06:00") for an IANA timezone.
// Used by buildArticlePrompt to tell Haiku exactly what offset to write
// in closed_from / closed_until — avoids the old bug where the prompt
// hardcoded Atlantic Time and Saskatchewan/Alberta/BC times got the
// wrong offset baked in by the LLM.
function getTzOffset(timezone, date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const parts = fmt.formatToParts(date);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (!tzPart) return null;
    // Intl emits values like 'GMT-06:00', 'GMT+00:00', or sometimes 'GMT' for UTC.
    if (tzPart.value === 'GMT') return '+00:00';
    const m = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

async function extractArticleClosure(opts) {
  const timezone = opts.timezone || 'America/Halifax';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const offset = getTzOffset(timezone) || '-03:00';

  const prompt = buildArticlePrompt({
    content:      opts.content,
    title:        opts.title,
    url:          opts.url,
    province:     opts.province,
    today,
    timezone,
    offset,
    source_label: opts.source_label || opts.source,
  });

  const { text, usage, model } = await callAnthropic(prompt);

  // Robust JSON object parse — strip fences and slice to first {...}
  let parsed;
  try {
    let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) throw new Error('no JSON object');
    parsed = JSON.parse(t.slice(first, last + 1));
  } catch (err) {
    throw new Error(`article extraction parse failed: ${err.message}; raw=${text.slice(0, 300)}`);
  }

  return { ...parsed, llm_model: model, llm_usage: usage };
}

// ============================================================
// makeLlmListProvider — for "list page → article detail" sources
// ============================================================
//
// Pattern: a provider has an INDEX page (RSS feed or HTML list) whose items
// each link to an individual article. We:
//   1. Fetch the index every pass (cheap)
//   2. Hash each article's URL → body_hash key
//   3. Look up cached classifications in source_classifications
//   4. Cache hit → skip the URL (it's already been classified; closure events
//      already recorded; isCurrentlyClosed time-window math on the server
//      handles expiration)
//   5. Cache miss → fetch article, call Haiku once, emit ParsedEntry with
//      pre-populated .llm verdict. Pipeline upserts classification, so next
//      pass hits the cache.
//
// Cost: ZERO LLM calls when nothing new. ONE LLM call per new article.

function makeLlmListProvider(config) {
  for (const k of ['name', 'province', 'data_source']) {
    if (!config[k]) throw new Error(`makeLlmListProvider: missing config.${k}`);
  }
  if (!config.rss_url && !(config.list_url && typeof config.list_extract === 'function')) {
    throw new Error(`makeLlmListProvider: provide rss_url OR (list_url + list_extract fn)`);
  }

  const dataSource = config.data_source;
  const sourceLabel = config.source_label || config.name;
  const indexUrl = config.rss_url || config.list_url;
  const useRss = !!config.rss_url;
  const maxItems = config.max_items || 20;

  // Per-article disk cache keyed by URL hash. Stores the LLM extraction
  // result so we can re-emit the full ParsedEntry on subsequent passes
  // without re-fetching the article or re-calling Haiku. Mirrors the
  // single-page provider's FileSystemPageCache pattern.
  const cacheDir = config.cache_dir || `/var/cache/erstat-scraper/${dataSource}`;
  const articleCache = new FileSystemPageCache(cacheDir);

  // Returns ParsedEntry-shaped objects for the pipeline. On cache hit we
  // re-emit the cached entry verbatim — this is critical for closure
  // persistence: if a URL is on the index but we emit nothing for it,
  // the server thinks the closure was resolved. Re-emitting keeps the
  // server's closure_event lifecycle correct. When the URL drops off
  // the index, we stop emitting it and the server correctly fires reopen.
  async function discoverAndExtract() {
    // Step 1: fetch index
    const indexBody = await fetchHtml(indexUrl);
    let items;
    if (useRss) {
      items = parseRssFeed(indexBody);
    } else {
      const $ = cheerio.load(indexBody);
      items = config.list_extract($, indexUrl) || [];
    }

    // Normalize URLs to absolute
    const baseUrl = new URL(indexUrl);
    items = items.map(it => {
      let absUrl = it.url;
      try { absUrl = new URL(it.url, baseUrl).toString(); } catch (_) {}
      return { ...it, url: absUrl };
    });

    // Cap items per pass — protect against huge index pages
    if (items.length > maxItems) items = items.slice(0, maxItems);

    if (items.length === 0) return { entries: [], total_items: 0, new_items: 0, cached_items: 0 };

    // Step 2: compute URL-derived body_hash for each item
    for (const it of items) {
      it.body_hash = hash(dataSource, 'list_url_v1', it.url);
    }

    const entries = [];
    let new_items = 0;
    let cached_items = 0;

    // Step 3: per-item — try disk cache first, fall back to fetch+LLM.
    //
    // CRITICAL: on cache hit we MUST re-emit the full ParsedEntry. If we
    // skip the URL, the pipeline emits zero entries to the server, and the
    // server interprets "this body_hash didn't appear" as "the closure was
    // resolved" — firing a false reopened_emitted event and flipping the
    // hospital back to official_status='open' in D1.
    //
    // CACHE STRATEGY — content-hash keyed, not URL-keyed (v2 design)
    //   Why: SHA (and likely others) EDIT published disruption articles in
    //   place — adding "Anticipated end" times, changing end times, marking
    //   resolutions. A URL-only cache key (v1) treated the article as
    //   immutable, so once we extracted it we'd never re-extract even after
    //   SHA updated the page. Result: stale closed_until values stayed in
    //   our cache forever, and isCurrentlyClosed kept returning true on
    //   articles whose actual end-time had passed days ago.
    //
    //   v2 fix: always fetch the article (cheap HTTP), hash the cleaned
    //   visible content, and use THAT as the cache key. Identical content
    //   → cache hit, no LLM call. Edited content → new hash → re-extract
    //   with the current text. The LLM cost ($) is what we're protecting,
    //   not the HTTP cost (negligible). v1 cache entries are naturally
    //   ignored due to the version bump.
    //
    // When a URL drops off the list (disruption resolved + page removed),
    // we naturally stop emitting it — server then correctly fires reopen.
    for (const item of items) {
      // Step A: always fetch + clean. This is the change vs. v1, which
      // skipped this on URL-cache-hit and thus never noticed in-place edits.
      let content;
      try {
        const articleHtml = await fetchHtml(item.url);
        content = extractVisibleContent(articleHtml);
        if (!content || content.length < 50) {
          console.error(`[${config.name}] article ${item.url} had empty content, skipping`);
          continue;
        }
      } catch (err) {
        console.error(`[${config.name}] failed to fetch ${item.url}: ${err.message}`);
        continue;
      }

      // Step B: content-derived cache key. URL is included in the key for
      // debuggability of on-disk cache files; content_hash is what makes
      // a stale-after-edit cache impossible.
      const contentHash = hash(content);
      const cacheKey = hash(dataSource, 'list_article_v2', item.url, contentHash);

      let result;
      let from_cache = false;

      const cached = await articleCache.get(cacheKey);
      if (cached && cached.llm_output) {
        // Same URL + same content as last time we LLM-extracted → reuse.
        result = cached.llm_output;
        from_cache = true;
        cached_items++;
      } else {
        // First time seeing this (URL, content) pair. Run the LLM.
        try {
          result = await extractArticleClosure({
            content,
            title:        item.title,
            url:          item.url,
            province:     config.province,
            timezone:     config.timezone,
            source_label: sourceLabel,
          });
          new_items++;
          try {
            await articleCache.set(cacheKey, {
              url:          item.url,
              content_hash: contentHash,
              llm_output:   result,
              cached_at:    new Date().toISOString(),
            });
          } catch (err) {
            console.error(`[${config.name}] cache.set failed for ${item.url}: ${err.message}`);
          }
        } catch (err) {
          console.error(`[${config.name}] failed to extract ${item.url}: ${err.message}`);
          continue;
        }
      }

      // ALWAYS emit a ParsedEntry, even if is_closure=false. The pipeline's
      // closure_entries filter drops is_closure=false entries downstream
      // but the advisory rows persist regardless.
      const facility_name = result.facility_name || item.title || '(unknown)';
      const facility_hint = slugify(facility_name);
      const service_label = result.service || 'Unknown';
      const body = result.body_excerpt || item.description || item.title || '';

      entries.push({
        source_record_id: item.url,
        facility_name,
        facility_hint,
        city:           result.city ? String(result.city).trim() : null,
        service_label,
        body,
        body_hash: item.body_hash,
        type_label: result.type || 'Advisory',
        subject_kind: 'facility',
        zone: null,
        location: null,
        metadata: {
          article_url:      item.url,
          article_title:    item.title,
          article_pub_date: item.pub_date,
          llm_model:        result.llm_model,
          llm_usage:        result.llm_usage,
          from_cache,
        },
        llm: {
          is_closure:    Boolean(result.is_closure),
          scope:         result.scope || null,
          closed_from:   result.closed_from || null,
          closed_until:  result.closed_until || null,
          reopen_phrase: result.reopen_phrase || null,
          confidence:    result.confidence || null,
          reasoning:     result.reasoning || null,
          model:         result.llm_model || null,
        },
      });
    }

    return { entries, total_items: items.length, new_items, cached_items };
  }

  return {
    name:        config.name,
    province:    config.province,
    data_source: dataSource,
    enabled:     config.enabled !== false,
    timezone:    config.timezone || 'America/Halifax',

    async fetch(/* ctx */) {
      // All the work happens in parse(); fetch is a no-op for this style.
      // Keeping the two-phase shape preserves the pipeline contract.
      return { _list_provider: true };
    },

    async parse(/* raw, ctx */) {
      const { entries, total_items, new_items, cached_items } = await discoverAndExtract();
      // Stash stats for the scrape summary
      if (entries._meta === undefined) {
        Object.defineProperty(entries, '_meta', {
          value: { total_items, new_items, cached_items },
          enumerable: false,
        });
      }
      return entries;
    },

    async resolveHospital(entry, ctx) {
      const r = resolveFacility(entry.facility_name, ctx.resolver, entry.city);
      if (r.facility_hint && r.facility_hint !== entry.facility_hint) {
        entry.facility_hint = r.facility_hint;
      }
      entry.metadata = { ...(entry.metadata || {}), resolved_via: r.via };
      if (r.matched_city) entry.metadata.matched_city = r.matched_city;
      return r.hospital_id;
    },

    async scope(ctx) {
      return ctx.resolver.knownHospitalIds();
    },
  };
}

module.exports = {
  makeLlmProvider,
  makeLlmListProvider,
  extractFromPage,
  extractVisibleContent,
  extractArticleClosure,
  parseRssFeed,
  FileSystemPageCache,
};
