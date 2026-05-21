// lib/classify_llm.js
// Calls Claude Haiku 4.5 to extract structured closure info from an entry's
// body text. Result is cached forever per body_hash in nshealth_classifications.
//
// Cost expectation: ~300 input + ~150 output tokens per call → ~$0.001 each.
// Fires only on new/changed body_hash → typically <30 calls/day.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.NSHEALTH_LLM_MODEL || 'claude-haiku-4-5-20251001';
const ENABLED = process.env.NSHEALTH_LLM_ENABLED !== '0';

const SYSTEM_PROMPT = `You extract structured closure information from Nova Scotia Health emergency department status notices.

Output strict JSON only. No preamble, no commentary, no markdown fences. Match this schema exactly:

{
  "is_closure": boolean,
  "scope": "full_ed" | "partial_hours" | "none",
  "closed_from": string | null,
  "closed_until": string | null,
  "reopen_phrase": string | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": string
}

Definitions:
- is_closure: TRUE when the notice describes an emergency department closure event — past, present, or future. FALSE for restricted-hours notices (ED is operating but with limited hours), non-ED notices, advisories about parking/security/blood collection/etc. This is a TIME-NAIVE judgment: do NOT decide based on whether the closure window is in the past, present, or future relative to the reference date. Downstream code uses closed_from / closed_until to determine whether the closure is currently in effect.
- scope:
  - "full_ed" — ED fully closed for a defined or open-ended period
  - "partial_hours" — ED open with restricted hours (NOT a closure)
  - "none" — not an ED status notice
- closed_from / closed_until: ISO 8601 with timezone offset. Nova Scotia uses Atlantic time. AST = UTC-04:00 (early November to mid-March). ADT = UTC-03:00 (mid-March to early November). Use the reference date provided to disambiguate the year and DST. Populate these accurately whenever the body states a window, regardless of whether the window is past, present, or future. For "closed Wed May 6 to Sun May 10", closed_until is the END of Sunday May 10 (e.g. 23:59:59 local time) since NSH date ranges are inclusive.
- reopen_phrase: short human-readable phrase for UI display (e.g. "reopens Monday at 8 a.m." or "reopens Tuesday May 12 at 8 a.m."), or null if no reopen time stated.
- confidence: high when phrasing is unambiguous; medium when interpretation required; low when guessing.
- reasoning: one short sentence explaining the classification.

Critical context — read carefully:
- Collaborative Emergency Centres (CECs) and other emergency-facility variants attached to a hospital are treated as Emergency Departments for closure classification. If the service heading is "Emergency Department" and the body refers to a CEC, classify exactly as you would for a regular ED.
- NSH date ranges are inclusive. "closed Wednesday May 6 to Sunday May 10" means the facility is closed for the entire duration from May 6 through and including May 10 (reopens after May 10).
- Phrases like "VUC is available even when the ED is closed" describe Virtual Urgent Care availability, not the ED's current state. Ignore them when deciding is_closure.

Rules:
- "is open from X to Y" with no closure verb → scope=partial_hours, is_closure=false.
- "temporarily closed" with no reopen time → is_closure=true, scope=full_ed, closed_from=null, closed_until=null.
- Service heading other than "Emergency Department" → scope=none, is_closure=false (UNLESS body explicitly says the ED is closed).
- If you cannot parse a date/time confidently, set the field to null. Never guess.
- Output JSON only — your entire response must parse with JSON.parse.

Worked examples (reference date "2026-05-10"):

Body: "The Cobequid Community Health Centre emergency department will close early at 5:00 p.m. on Friday, May 8, and will reopen at 8:00 a.m. on Saturday, May 9."
→ {"is_closure": true, "scope": "full_ed", "closed_from": "2026-05-08T17:00:00-03:00", "closed_until": "2026-05-09T08:00:00-03:00", "reopen_phrase": "reopened Saturday May 9 at 8 a.m.", "confidence": "high", "reasoning": "ED closure event with stated start and end times. Window is in the past relative to reference date — downstream code will determine current applicability."}

Body: "The emergency department at Guysborough Memorial Hospital will be closed from 12 p.m. on Monday, May 11 until 1 p.m. on Tuesday, May 12."
→ {"is_closure": true, "scope": "full_ed", "closed_from": "2026-05-11T12:00:00-03:00", "closed_until": "2026-05-12T13:00:00-03:00", "reopen_phrase": "reopens Tuesday May 12 at 1 p.m.", "confidence": "high", "reasoning": "Future-scheduled ED closure with clear start and end times."}

Body: "The All Saints Springhill Hospital Collaborative Emergency Centre (CEC) is temporarily closed."
→ {"is_closure": true, "scope": "full_ed", "closed_from": null, "closed_until": null, "reopen_phrase": null, "confidence": "high", "reasoning": "Open-ended ED closure with no stated reopen — CEC treated as ED."}

Body: "Fishermen's Memorial Hospital emergency department is open from 7:30 a.m. to 12 p.m. (noon) on Sunday May 10. Virtual Urgent Care is open 8 a.m. to 7 p.m. daily even when the emergency department is closed."
→ {"is_closure": false, "scope": "partial_hours", "closed_from": null, "closed_until": null, "reopen_phrase": null, "confidence": "high", "reasoning": "ED operating with restricted hours. The 'even when ED is closed' phrasing is a sub-clause about VUC availability, not a claim about today's ED state."}`;

function buildUserMessage(entry, refDate) {
  return `Reference date (current local Atlantic date): ${refDate}
Service heading: ${entry.service || '(none)'}
Entry type: ${entry.type || '(none)'}
Facility: ${entry.subject_name || '(unknown)'}${entry.location ? ` (${entry.location})` : ''}

Body:
${entry.body}`;
}

async function callAnthropic(entry, refDate) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(entry, refDate) }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) throw new Error('No text block in Anthropic response');
    const raw = textBlock.text.trim();
    // Strip code fences if model returned any (it shouldn't, but be safe)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`LLM output not valid JSON: ${cleaned.slice(0, 200)}`);
    }
    return {
      is_closure: !!parsed.is_closure,
      scope: parsed.scope || 'none',
      closed_from: parsed.closed_from || null,
      closed_until: parsed.closed_until || null,
      reopen_phrase: parsed.reopen_phrase || null,
      confidence: parsed.confidence || 'low',
      reasoning: parsed.reasoning || '',
      raw_response: data,
      model: data.model || MODEL,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function classifyLLM(entry, refDate) {
  if (!ENABLED) {
    return { skipped: true, reason: 'NSHEALTH_LLM_ENABLED=0' };
  }
  return callAnthropic(entry, refDate);
}

module.exports = { classifyLLM, MODEL };
