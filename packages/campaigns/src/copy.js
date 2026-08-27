// RSA copy — engine-spec §5 "RSA copy (Fable)". Claude writes, code decides:
// the model drafts headlines/descriptions from crawled site language, the
// offer and witnessed prices; validateCopy() hard-validates every line and
// the deterministic builder copy is the fallback when the model is absent,
// fails, or fails validation. No invented numbers: any price in the copy
// must match a price the crawler witnessed on the site.
//
//   draftCopy({ business, service, location, offers, prices, tone, generate, modelId }) -> { rsa, source, model_version, rejected }
//   validateCopy(rsa, { witnessedPrices }) -> { ok, problems[], rsa (normalised) }
//   policyScreen(text) -> [reasons]      Google-policy pre-screen, conservative
//   diffCopy(drafted, shipped) -> [{ kind, index, drafted, shipped }]   (edit-before-approve label, §11.3)

const LIMITS = { headline: 30, description: 90, min_headlines: 8, max_headlines: 15, min_descriptions: 3, max_descriptions: 4 };

// Customer register: no trade vocabulary in ads either (master §4), plus the
// Google policy tripwires we can catch before submission.
const JARGON = [/\bconversion\b/i, /\bimpressions?\b/i, /\bCTR\b/, /\bCPC\b/, /\bROAS\b/i, /\bkeywords?\b/i, /\bPPC\b/, /\bSEM\b/];
const POLICY = [
  { re: /(?:^|\s)#\s?1\b|\b(number one|the best|world'?s best|best in)\b/i, why: 'unverifiable superlative' },
  { re: /\bguarantee[ds]?\b/i, why: 'guarantee claim' },
  { re: /\bclick here\b/i, why: 'call-to-click text' },
  { re: /\b(cure|cures|heal|treats?|treatment for)\b/i, why: 'medical claim' },
  { re: /[!?]{2,}/, why: 'repeated punctuation' },
  { re: /\b[A-Z]{5,}\b/, why: 'shouting caps' },
  { re: /(\d)\s?%\s?off/i, why: 'discount claim needs a witnessed price' },
  { re: /\bfree\b/i, why: '"free" claim must be true on the page' },
];
const PRICE_RE = /(?:AED|USD|GBP|EUR|\$|€|£)\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?)|(\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?)\s?(?:AED|USD|GBP|EUR|dirhams?|dollars?|pounds?)/gi;

const normalise = (s) => String(s || '').replace(/\s*[—–]\s*/g, ' - ').replace(/\s+/g, ' ').trim();

function pricesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(PRICE_RE)) out.push(Number((m[1] || m[2]).replace(/,/g, '')));
  return out;
}

function policyScreen(text) {
  return POLICY.filter((p) => p.re.test(text)).map((p) => p.why);
}

function validateLine(kind, text, witnessed, problems, index) {
  const t = normalise(text);
  const label = `${kind} ${index + 1}`;
  if (!t) { problems.push(`${label}: empty`); return t; }
  if (t.length > LIMITS[kind]) problems.push(`${label}: ${t.length} characters (limit ${LIMITS[kind]})`);
  const j = JARGON.find((re) => re.test(t));
  if (j) problems.push(`${label}: trade vocabulary ("${t.match(j)[0]}")`);
  for (const why of policyScreen(t)) problems.push(`${label}: ${why}`);
  for (const p of pricesIn(t)) {
    if (!witnessed.some((w) => Math.abs(w - p) < 0.01)) problems.push(`${label}: price ${p} was not seen on your site`);
  }
  return t;
}

function validateCopy(rsa, { witnessedPrices = [] } = {}) {
  const problems = [];
  const headlines = (rsa && rsa.headlines || []).map((h, i) => validateLine('headline', h, witnessedPrices, problems, i));
  const descriptions = (rsa && rsa.descriptions || []).map((d, i) => validateLine('description', d, witnessedPrices, problems, i));
  if (headlines.length < LIMITS.min_headlines) problems.push(`needs at least ${LIMITS.min_headlines} headlines (has ${headlines.length})`);
  if (headlines.length > LIMITS.max_headlines) problems.push(`more than ${LIMITS.max_headlines} headlines`);
  if (descriptions.length < LIMITS.min_descriptions) problems.push(`needs at least ${LIMITS.min_descriptions} descriptions (has ${descriptions.length})`);
  if (descriptions.length > LIMITS.max_descriptions) problems.push(`more than ${LIMITS.max_descriptions} descriptions`);
  const dupH = new Set(headlines.map((h) => h.toLowerCase())); if (dupH.size !== headlines.length) problems.push('duplicate headlines');
  const pinned = {};
  for (const [k, v] of Object.entries((rsa && rsa.pinned) || {})) {
    const nv = normalise(v);
    if (headlines.includes(nv) || descriptions.includes(nv)) pinned[k] = nv;
  }
  if (Object.keys(pinned).length > 2) problems.push('more than 2 pinned lines (Google needs room to test)');
  return { ok: problems.length === 0, problems, rsa: { headlines, descriptions, pinned } };
}

function brief({ business, service, location, offers = [], prices = [], siteLines = [] }) {
  return [
    `Write Google search ad text for ${business}${service ? `, for the service "${service}"` : ''}${location ? ` in ${location}` : ''}.`,
    'Return ONLY a JSON object: {"headlines": [12 strings, each 30 characters or fewer], "descriptions": [4 strings, each 90 characters or fewer]}.',
    'Rules: plain, specific, no exclamation marks, no superlatives (best, #1), no guarantees, no "click here", no advertising jargon, no em dashes.',
    'Include the business name in at least two headlines and the service in at least three. Mention a price ONLY from this list, verbatim, or not at all:',
    prices.length ? prices.map((p) => `${p.currency || ''} ${p.amount}${p.label ? ` (${p.label})` : ''}`.trim()).join('; ') : '(no prices known — do not mention prices)',
    offers.length ? `Offers you may mention: ${offers.join('; ')}` : '',
    siteLines.length ? `Language from their website to echo: ${siteLines.slice(0, 8).join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Draft with the model, validate hard, fall back to the deterministic copy.
 * fallback: the builder's rsa for this ad group (always valid by construction).
 */
async function draftCopy({ business, service, location, offers, prices, siteLines, generate, modelId = null, fallback }) {
  const witnessed = (prices || []).map((p) => Number(p.amount)).filter((n) => Number.isFinite(n));
  const rejected = [];
  if (generate) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await generate({
          system: 'You write short, honest Google search ads for small local businesses. Plain words. Never invent facts or prices.',
          prompt: brief({ business, service, location, offers, prices, siteLines }) + (rejected.length ? `\nYour last draft was rejected: ${rejected.at(-1).join('; ')}. Fix every problem.` : ''),
        });
        const parsed = JSON.parse(String(raw).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
        const merged = { headlines: parsed.headlines || [], descriptions: parsed.descriptions || [], pinned: (fallback && fallback.pinned) || {} };
        const v = validateCopy(merged, { witnessedPrices: witnessed });
        if (v.ok) return { rsa: v.rsa, source: 'model', model_version: modelId, rejected };
        rejected.push(v.problems);
      } catch (e) {
        rejected.push([`model error: ${String(e.message || e).slice(0, 120)}`]);
      }
    }
  }
  // Builder copy is deterministic but a long business name can overflow a
  // headline — drop over-length lines rather than ship something Google rejects.
  const safe = {
    headlines: ((fallback && fallback.headlines) || []).map(normalise).filter((h) => h.length <= LIMITS.headline),
    descriptions: ((fallback && fallback.descriptions) || []).map(normalise).filter((d) => d.length <= LIMITS.description),
    pinned: (fallback && fallback.pinned) || {},
  };
  const fb = validateCopy(safe, { witnessedPrices: witnessed });
  return { rsa: fb.rsa, source: 'builder', model_version: null, rejected, fallback_problems: fb.problems };
}

/** Edit-before-approve diff: what the human changed vs what was drafted (§11.3 label). */
function diffCopy(drafted, shipped) {
  const out = [];
  for (const kind of ['headlines', 'descriptions']) {
    const a = (drafted && drafted[kind]) || []; const b = (shipped && shipped[kind]) || [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (normalise(a[i]) !== normalise(b[i])) out.push({ kind: kind.slice(0, -1), index: i, drafted: a[i] ?? null, shipped: b[i] ?? null });
    }
  }
  return out;
}

module.exports = { draftCopy, validateCopy, policyScreen, diffCopy, LIMITS, normalise };
