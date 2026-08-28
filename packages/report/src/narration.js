// Narration stage — build-doc §2.2, §8 (narration step).
// Sonnet writes `title` and `explanation` per finding plus the envelope's
// narrative slots. BINDING RULES enforced here, not hoped for:
//   1. The model NEVER sees `payload` (register safety — it cannot leak
//      locked detail it never received).
//   2. The model may repeat numbers verbatim, never derive new ones — every
//      number token in its output must already appear in its input.
// The model client is injected: async generate({system, prompt}) -> string.

const SYSTEM_PROMPT = [
  'You write short plain-language findings for small-business owners about their Google ads and visit tracking.',
  'Register rules, absolute: no marketing-tool jargon. Never say container, snippet, property, conversion action, or measurement ID.',
  'Say "your tracking", "your ads", "customer actions". One or two sentences per field. Warm, direct, concrete.',
  'You may repeat numbers from the data exactly as given. NEVER compute, estimate, round, or combine numbers yourself.',
  'Money: the data carries a currency code (money_currency). Write amounts in THAT currency ("AED 1,692"); only use "$" when the code is USD. Never convert.',
].join(' ');

/** What the model is allowed to see: the finding minus payload. */
function narrationInput(finding) {
  const { payload, ...safe } = finding;
  if (safe.money && safe.money.currency) safe.money_currency = safe.money.currency;
  else if (safe.money_impact_currency_local && safe.money_impact_currency_local.code) safe.money_currency = safe.money_impact_currency_local.code;
  return safe;
}

/** Every number in `text` must appear in the input object - compared as
 * values, so "1692.00" in the data grounds "$1,692" in the prose. */
function numbersAreGrounded(text, input) {
  const source = JSON.stringify(input);
  const toValue = (n) => Number(n.replace(/[,.]$/, '').replace(/,/g, ''));
  const sourceValues = new Set((source.match(/\d[\d,.]*/g) || []).map(toValue).filter(Number.isFinite));
  const numbers = (text.match(/\d[\d,.]*/g) || []).map(toValue).filter(Number.isFinite);
  return numbers.every((v) => sourceValues.has(v)
    // A percentage or count rounded to an integer of a decimal in the data is still the data's number.
    || (Number.isInteger(v) && [...sourceValues].some((s) => Math.round(s) === v)));
}

/** Models fence and preface JSON; take the outermost object and parse that. */
function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * Narrate one finding. Returns { title, explanation } or throws after
 * `retries` ungrounded attempts (caller degrades: engine-side fallback copy).
 */
async function narrateFinding(finding, generate, retries = 2) {
  const input = narrationInput(finding);
  let why = 'no reply';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await generate({
      system: SYSTEM_PROMPT,
      prompt: [
        'Write a JSON object {"title": "...", "explanation": "..."} for this finding.',
        'title: under 10 words, the concrete problem. explanation: 1-2 sentences, what it means for their money.',
        attempt > 0 ? 'Your previous attempt used a number not present in the data. Only repeat numbers exactly as they appear.' : '',
        JSON.stringify(input),
      ].filter(Boolean).join('\n'),
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) { why = `unparseable reply: ${String(raw).slice(0, 80)}`; continue; }
    if (typeof parsed.title !== 'string' || typeof parsed.explanation !== 'string') { why = `wrong shape: ${Object.keys(parsed).join(',')}`; continue; }
    if (numbersAreGrounded(parsed.title + ' ' + parsed.explanation, input)) return parsed;
    why = `ungrounded number in: ${(parsed.title + ' ' + parsed.explanation).slice(0, 80)}`;
  }
  throw new Error(`narration failed after ${retries + 1} attempts (${why}): ${finding.rule_id}`);
}

/** Narrate the envelope slots from engine-computed aggregates only. */
async function narrateSlots({ counts, totals, previousWeek }, generate) {
  const input = { counts, totals, previous_week: previousWeek || null };
  const raw = await generate({
    system: SYSTEM_PROMPT,
    prompt: [
      'Write a JSON object {"exec_summary": "...", "since_last_week": "..."} for this week\'s report.',
      'exec_summary: 1-2 sentences, lead with the most important thing. since_last_week: 1 sentence; if previous_week is null say this is the first look.',
      JSON.stringify(input),
    ].join('\n'),
  });
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed.exec_summary !== 'string') throw new Error('slot narration unparseable');
  if (!numbersAreGrounded(parsed.exec_summary + ' ' + (parsed.since_last_week || ''), input)) {
    throw new Error('slot narration ungrounded');
  }
  return parsed;
}

module.exports = { narrationInput, numbersAreGrounded, parseJsonObject, narrateFinding, narrateSlots, SYSTEM_PROMPT };
