// lib/classify_regex.js
// Deterministic regex classifier. Used as:
//   (a) fallback when the LLM call fails or LLM is disabled
//   (b) audit baseline — daily diff against LLM verdicts surfaces drift
//
// Bias: false-negatives (missing a real closure) are more harmful for ER
// routing than false-positives. When ED + Disruption matches no recognised
// pattern, we still flag closed=true and set needs_review=true.

const CLOSURE_PATTERNS = [
  /\btemporarily closed\b/i,
  /\bis closed\b/i,
  /\bwill be closed\b/i,
  /\bwill close (?:early )?at\b/i,
  /\bclose early\b/i,
  /\bclosed from\b/i,
  /\bclosed today\b/i,
  /\bclosed (?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bclosed (?:this|next) (?:week|weekend|morning|afternoon|evening|night)\b/i,
  /\bclosed (?:january|february|march|april|may|june|july|august|september|october|november|december) \d+/i,
];

const RESTRICTED_HOURS_PATTERNS = [
  /\b(?:emergency department\s+)?(?:is\s+)?open from \d/i,
  /\b(?:open|operating) from \d{1,2}(?::\d{2})? ?(?:a\.?m\.?|p\.?m\.?)? to \d/i,
];

function classifyRegex(entry) {
  const isED = /^emergency department$/i.test(entry.service || '');
  const isClosureType = /^(disruption|emergency situation in progress)$/i.test(entry.type || '');

  if (!isED || !isClosureType || !entry.facility_slug) {
    return {
      is_closure: false,
      scope: 'none',
      needs_review: false,
      source_phrase: null,
    };
  }

  // Pre-process: strip "even when/if/though [X] is closed" subordinate clauses.
  // These appear in VUC/CEC availability statements like
  //   "Virtual Urgent Care is open 8 a.m. to 7 p.m. daily even when the
  //    emergency department is closed."
  // and are NOT claims about the ED's current state. If we don't strip them,
  // a hospital that's actually open with restricted hours gets misclassified.
  const rawBody = (entry.body || '').replace(/\s+/g, ' ');
  const body = rawBody.replace(
    /\beven\s+(?:when|if|though)\b[^.]*?\bclosed\b[^.]*?(?=\.|$)/gi,
    ''
  );

  const hasClosurePhrase = CLOSURE_PATTERNS.some((rx) => rx.test(body));
  const hasRestrictedHours = RESTRICTED_HOURS_PATTERNS.some((rx) => rx.test(body));

  // Restricted hours wins ONLY if there is no concurrent closure phrase.
  // (NSH sometimes writes "open from 8am to 4pm; closed overnight" — that's
  // a closure for the off-hours portion, treat as closure.)
  if (hasRestrictedHours && !hasClosurePhrase) {
    return {
      is_closure: false,
      scope: 'partial_hours',
      needs_review: false,
      source_phrase: extractFirstSentence(body, RESTRICTED_HOURS_PATTERNS),
    };
  }

  if (hasClosurePhrase) {
    return {
      is_closure: true,
      scope: 'full_ed',
      needs_review: false,
      source_phrase: extractFirstSentence(body, CLOSURE_PATTERNS),
    };
  }

  // ED + Disruption with no recognised pattern → flag as closure pending review.
  // False-positive cost (one extra alert) << false-negative cost (user goes to
  // a closed ED). Daily audit catches the regex gap and refines patterns.
  return {
    is_closure: true,
    scope: 'full_ed',
    needs_review: true,
    source_phrase: body.slice(0, 200),
  };
}

function extractFirstSentence(body, patterns) {
  for (const rx of patterns) {
    const m = body.match(new RegExp(`[^.!?]*${rx.source}[^.!?]*[.!?]?`, rx.flags));
    if (m) return m[0].trim().slice(0, 240);
  }
  return body.slice(0, 200);
}

module.exports = { classifyRegex };
