// lib/pipeline.js
//
// The shared provincial-scraper orchestration. Lifted verbatim (in spirit)
// from the original nshealth_scrape.js main() — same control flow, same
// semantics, just driven by a provider module instead of hard-coded NSH
// logic.
//
// Pipeline per provider:
//   1. provider.fetch()                        — raw source data
//   2. provider.parse(raw)                     — ParsedEntry[]
//   3. resolve hospital_ids via provider's resolver (config/providers/{name}.json)
//   4. dedupe by body_hash
//   5. regex classify each entry (deterministic fallback + audit baseline)
//   6. POST body_hashes → /scraper/cached-classifications (single round trip)
//   7. For uncached entries: call provider.classifyLLM() (or shared classifier)
//   8. Resolve verdict per entry (LLM > regex)
//   9. Compute currently-closed via wall-clock isCurrentlyClosed
//  10. POST atomic /scraper/pass — server does all DB writes in one tx
//  11. D1 sync — write official_status / er_closure_end for provider's scope
//
// The provider declares its `data_source` string; everything downstream
// keys on that so multiple provinces can share the same TimescaleDB tables
// without colliding.

const { classifyRegex }                         = require('./classify_regex');
const { classifyLLM: defaultClassifyLLM }       = require('./classify_llm');
const { lookupCachedClassifications, applyPass } = require('./api');
const { syncToD1, isConfigured: isD1Configured } = require('./d1_sync');
const { makeResolver }                          = require('./hospital_resolver');

// Time-window arithmetic. The classifier marks is_closure=true for any
// notice that DESCRIBES a closure event (past, present, or future) — that
// way LLM verdicts can be cached forever per body_hash. Here we derive
// current applicability using closed_from / closed_until and the wall clock.
function isCurrentlyClosed(verdict, now = new Date()) {
  if (!verdict || !verdict.is_closure) return false;
  const cf = verdict.closed_from  ? new Date(verdict.closed_from)  : null;
  const cu = verdict.closed_until ? new Date(verdict.closed_until) : null;
  if (!cf && !cu) return true;          // open-ended ("temporarily closed")
  if (cf && now < cf) return false;     // before stated window — not yet
  if (cu && now > cu) return false;     // after stated window — already over
  return true;                          // inside the window
}

// Truncate a passage to fit a UI card without mid-word cuts. Prefers cutting
// at the last sentence-ending punctuation within the limit; falls back to
// last word boundary; ellipsis only when we actually had to cut.
function smartTruncate(text, max) {
  if (!text) return null;
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! ')
  );
  if (sentenceEnd >= max * 0.5) {
    return slice.slice(0, sentenceEnd + 1);
  }
  const wordEnd = slice.lastIndexOf(' ');
  if (wordEnd >= max * 0.6) {
    return slice.slice(0, wordEnd).replace(/[,;:.\s]+$/, '') + '…';
  }
  return slice + '…';
}


// Allow list of service labels that ERstat considers ED-affecting. A closure
// entry that doesn't match one of these is treated as a non-ED service
// disruption and dropped from closure_entries (it still persists as advisory
// data on the server, but it doesn't flip official_status on the hospital).
//
// Conservative default: missing/empty/unknown service is treated as ED-
// affecting. That preserves legacy behavior for any provider that doesn't
// populate the service field — its closures still count. The cost is that a
// genuinely non-ED entry with a null service label slips through; the cost
// of the inverse (silently dropping a real ED closure because a provider
// forgot to set service) is much worse.
//
// Why an allow list instead of a block list: "Obstetrics down" entries from
// AHS were being treated as full hospital closures because their service
// said "Obstetrics" and is_closure=true. A block list ("not in {obstetrics,
// lab, ...}") would need to be exhaustive — easier to enumerate the small
// set of labels that DO indicate ED than the open-ended set that don't.
const ED_SERVICE_LABELS = new Set([
  'emergency department',
  'emergency room',
  'emergency',
  'emergency services',
  'emergency care',
  'ed',
  'er',
]);
function isEdServiceClosure(entry) {
  const raw = entry && entry.service_label;
  if (raw == null) return true;                         // missing → assume ED (legacy compat)
  const s = String(raw).toLowerCase().trim();
  if (s === '' || s === 'unknown') return true;         // empty / placeholder → assume ED
  if (ED_SERVICE_LABELS.has(s)) return true;
  // Forgiving suffix match: "Emergency Department services", "Emergency Dept",
  // "Adult Emergency Department" etc. all read as ED-affecting.
  if (/\bemergency\s+(department|room|dept|services?|care)\b/i.test(raw)) return true;
  if (/\bemergency\b/i.test(raw) && !/(non-emergency|emergency planning|emergency response)/i.test(raw)) {
    // Bare "Emergency" qualifier — accept, but excluding clear non-ED senses.
    return true;
  }
  return false;
}

function todayLocalISO(timezone = 'America/Halifax') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dedupeByHash(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    if (!e.body_hash) return false;
    if (seen.has(e.body_hash)) return false;
    seen.add(e.body_hash);
    return true;
  });
}

/**
 * Run the full pipeline for a single provider. Returns the summary JSON
 * the caller can log / publish.
 */
async function runProvider(provider, opts = {}) {
  const t0 = Date.now();
  const tz = provider.timezone || 'America/Halifax';
  const refDate = todayLocalISO(tz);

  const summary = {
    provider: provider.name,
    province: provider.province,
    data_source: provider.data_source,
    ref_date: refDate,
    fetched: 0, parsed: 0, after_dedupe: 0,
    llm_calls: 0, llm_errors: 0, llm_cache_hits: 0,
    regex_review_needed: 0, unknown_slugs: 0,
    closures_currently_active: 0,
    closures_described_total: 0,
  };

  const resolver = makeResolver(provider.name);
  const llmFn    = provider.classifyLLM || defaultClassifyLLM;
  const ctx      = { resolver, provider, summary, refDate };

  // 1. Fetch
  let raw;
  try {
    raw = await provider.fetch(ctx);
  } catch (err) {
    return {
      ok: false,
      stage: 'fetch',
      provider: provider.name,
      error: err.message,
      elapsed_ms: Date.now() - t0,
    };
  }

  // 2. Parse
  let entries;
  try {
    entries = await provider.parse(raw, ctx);
  } catch (err) {
    return {
      ok: false,
      stage: 'parse',
      provider: provider.name,
      error: err.message,
      elapsed_ms: Date.now() - t0,
    };
  }
  summary.fetched = raw?.total ?? entries.length;
  summary.parsed = entries.length;

  // 3. Resolve hospital_ids
  const audit_events = [];
  for (const e of entries) {
    e.hospital_id = await provider.resolveHospital
      ? await provider.resolveHospital(e, ctx)
      : resolver.lookupSlug(e.facility_hint);

    if (e.facility_hint && !e.hospital_id) {
      summary.unknown_slugs++;
      audit_events.push({
        kind: 'unknown_slug',
        detail: { slug: e.facility_hint, name: e.facility_name },
      });
    }
  }

  // 4. Dedupe
  const deduped = dedupeByHash(entries);
  summary.after_dedupe = deduped.length;

  // 5. Regex classify (always — deterministic fallback + audit).
  //    Skipped for entries that arrive pre-classified from the provider
  //    (e.g. llm_page_extractor sources, where the LLM already returned a
  //    structured verdict at parse time).
  for (const e of deduped) {
    if (e.llm) { e.regex = null; continue; }
    e.regex = classifyRegex(toClassifierEntry(e));
    if (e.regex?.needs_review) summary.regex_review_needed++;
  }

  // 6. Cache lookup (single round trip). Skipped for pre-classified entries.
  const needsCache = deduped.filter(e => !e.llm).map(e => e.body_hash);
  const cached = needsCache.length
    ? await lookupCachedClassifications(provider.data_source, needsCache)
    : {};

  // 7. LLM for cache misses, classifications for everyone (so the server
  //    upserts the cache row regardless of where the verdict came from).
  const classifications = {};
  for (const e of deduped) {
    // 7a. Pre-classified by provider (llm_page_extractor path).
    if (e.llm) {
      summary.llm_provider_supplied = (summary.llm_provider_supplied || 0) + 1;
      classifications[e.body_hash] = {
        llm: e.llm, llm_error: null, regex: null,
      };
      continue;
    }

    // 7b. Cache hit — already-classified body_hash.
    const hit = cached[e.body_hash];
    if (hit && hit.llm_is_closure !== null && !hit.llm_error) {
      summary.llm_cache_hits++;
      e.llm = {
        is_closure:    hit.llm_is_closure,
        scope:         hit.llm_scope,
        closed_from:   hit.llm_closed_from,
        closed_until:  hit.llm_closed_until,
        reopen_phrase: hit.llm_reopen_phrase,
        confidence:    hit.llm_confidence,
        reasoning:     hit.llm_reasoning,
        model:         hit.llm_model,
      };
      classifications[e.body_hash] = {
        llm: e.llm, llm_error: null, regex: e.regex,
      };
      continue;
    }

    // 7c. Cache miss — call the per-entry LLM classifier.
    let llm = null, llm_error = null;
    try {
      const result = await llmFn(toClassifierEntry(e), refDate);
      if (result?.skipped) {
        llm_error = result.reason || 'llm_disabled';
      } else {
        llm = result;
        summary.llm_calls++;
      }
    } catch (err) {
      summary.llm_errors++;
      llm_error = err.message;
      console.error(`[${provider.name}] LLM error hash=${e.body_hash.slice(0,8)}: ${err.message}`);
    }
    e.llm = llm;
    classifications[e.body_hash] = { llm, llm_error, regex: e.regex };

    if (llm && e.regex && llm.is_closure !== e.regex.is_closure) {
      audit_events.push({
        kind: 'disagreement',
        body_hash: e.body_hash,
        hospital_id: e.hospital_id,
        detail: {
          regex: e.regex,
          llm: { is_closure: llm.is_closure, scope: llm.scope,
                 confidence: llm.confidence, reasoning: llm.reasoning },
          subject: e.facility_name,
          service: e.service_label,
        },
      });
    }
  }

  // 8. Resolve verdict per entry (LLM > regex)
  for (const e of deduped) {
    e.verdict = e.llm
      ? {
          is_closure:      e.llm.is_closure,
          scope:           e.llm.scope,
          closed_from:     e.llm.closed_from,
          closed_until:    e.llm.closed_until,
          reopen_phrase:   e.llm.reopen_phrase,
          expected_reopen: e.llm.closed_until,
        }
      : {
          is_closure:      e.regex?.is_closure || false,
          scope:           e.regex?.scope || 'none',
          closed_from:     null,
          closed_until:    null,
          reopen_phrase:   null,
          expected_reopen: null,
        };
    if (e.verdict.is_closure) summary.closures_described_total++;
  }

  // 9. Currently-closed filter
  //
  // scope semantics — two classifiers feed this, with different vocabularies:
  //
  //   LLM extractor (lib/llm_page_extractor.js prompt):
  //     'full'              -> service fully unavailable. official_status='closed'.
  //     'partial_hours'     -> service runs reduced hours. official_status='disruption'.
  //     'partial_service'   -> some sub-services unavailable. official_status='disruption'.
  //     'reduced'           -> generic capacity reduction. official_status='disruption'.
  //
  //   Regex classifier (lib/classify_regex.js, NS Health path):
  //     'full_ed'           -> ED fully closed (treated as 'full' here). official_status='closed'.
  //     'partial_hours'     -> ED on restricted hours (regex marks is_closure=false; never reaches here).
  //     'none'              -> not a closure (never reaches here).
  //
  // ERstat tracks ED status only. A NS Health ED that's "closed but virtual care
  // available via CEC" is functionally closed for a walk-in patient — the regex
  // correctly marks it scope='full_ed'. We map that to 'closed', NOT 'disruption'.
  //
  // SERVICE FILTER (defense in depth)
  //   The LLM prompt instructs Haiku to set is_closure=false for non-ED service
  //   disruptions (obstetrics down, lab unavailable, etc.). But we don't want a
  //   single misbehaving extraction to flip a hospital's ED to closed when the
  //   real disruption was something else. So we ALSO filter here by service
  //   label. Conservative default: missing/empty/unknown service is treated as
  //   ED-affecting (preserves NS Health behavior — its regex always sets
  //   service='Emergency Department', but if any future provider doesn't set
  //   one we shouldn't silently drop their closures).
  //
  // The d1_status decision is made HERE, not in d1_sync, so the d1_sync module
  // stays simple and providers don't all need scope-aware code.
  const FULL_SCOPES = new Set(['full', 'full_ed', 'none', null, undefined]);
  const closure_entries = deduped
    .filter((e) => isCurrentlyClosed(e.verdict) && e.hospital_id && isEdServiceClosure(e))
    .map((e) => {
      const scope = e.verdict.scope || 'full';
      const isFull = FULL_SCOPES.has(scope);
      // Build a one-liner from what the LLM already gave us (body excerpt
      // or reason text). Capped at 280 chars to fit in a UI badge / OG card.
      const raw = (e.body || '').replace(/\s+/g, ' ').trim();
      const message = raw ? smartTruncate(raw, 500) : null;
      return {
        hospital_id:     e.hospital_id,
        body_hash:       e.body_hash,
        scope,
        d1_status:       isFull ? 'closed' : 'disruption',
        d1_message:      message,
        reopen_phrase:   e.verdict.reopen_phrase,
        // Only full closures get an er_closure_end timestamp. For reduced-
        // hours / partial-service entries, "end" doesn't have a single value.
        expected_reopen: isFull ? e.verdict.expected_reopen : null,
        reason:          (e.body || '').slice(0, 500),
      };
    });
  summary.closures_currently_active = closure_entries.length;

  // 10. Apply pass — single atomic call to TS
  const passEntries = deduped.map((e) => ({
    facility_slug: e.facility_hint,   // legacy field name kept for server compat
    hospital_id:   e.hospital_id,
    zone:          e.zone || null,
    subject_kind:  e.subject_kind || 'facility',
    subject_name:  e.facility_name,
    location:      e.location || null,
    type:          e.type_label || null,
    service:       e.service_label,
    body:          e.body,
    body_hash:     e.body_hash,
  }));

  const elapsed = Date.now() - t0;
  let serverResponse;
  try {
    serverResponse = await applyPass({
      source: provider.data_source,
      entries: passEntries,
      classifications,
      closure_entries,
      audit_events,
      scrape_summary: { elapsed_ms: elapsed, ...summary },
    });
  } catch (err) {
    return {
      ok: false,
      stage: 'apply_pass',
      provider: provider.name,
      error: err.message,
      elapsed_ms: Date.now() - t0,
      summary,
    };
  }

  // 11. D1 sync — scoped to this provider's hospital_ids only
  let d1_sync = null;
  try {
    if (isD1Configured()) {
      const scopeIds = await (
        provider.scope ? provider.scope(ctx) : resolver.knownHospitalIds()
      );
      d1_sync = await syncToD1({
        provider: provider.name,
        scopeIds: new Set(scopeIds),
        closures: closure_entries,
      });
    } else {
      d1_sync = { skipped: true, reason: 'CF env vars not set' };
    }
  } catch (err) {
    console.error(`[${provider.name}] D1 sync failed (non-fatal): ${err.message}`);
    d1_sync = { ok: false, error: err.message };
  }

  return {
    ok: true,
    elapsed_ms: elapsed,
    ...summary,
    server_response: serverResponse,
    d1_sync,
  };
}

/**
 * Adapter: the existing classifiers (regex + LLM) were written against the
 * NSH-shaped entry object. The new ParsedEntry shape has different field
 * names. This adapter bridges them without rewriting the classifiers.
 */
function toClassifierEntry(e) {
  return {
    type:           e.type_label,
    service:        e.service_label,
    facility_slug:  e.facility_hint,
    subject_name:   e.facility_name,
    body:           e.body,
  };
}

module.exports = { runProvider, isCurrentlyClosed, todayLocalISO };

