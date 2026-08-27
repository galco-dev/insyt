// Request interpretation — engine-spec §6.5 / §7.1 "Draft". Free text → the
// model turns it into a STRUCTURED intent (never a change) → deterministic
// code maps the intent onto a registry-shaped change, validates it against
// the bounds, and produces a card. Out-of-bounds requests degrade to the
// nearest allowed version with the bound stated. Un-mappable requests become
// an honest reply + an unanswered-log row (the customer-written backlog).
//
//   interpretRequest({ text, ctx, generate }) -> { intent, draft | null, reply, unanswered: bool }
//   ctx = { campaigns: [{ id, name, status, budget_daily_usd, budget_resource }], convertingTerms: Set,
//           pausedByUs: Set, autopilot: {negatives,budgets,counting}, bounds: state for checkBounds }
//
// Consent lanes (§7.2): every bot-drafted change is ask-first — the card is
// the only thing that executes anything. The one asymmetry: "stop autopilot"
// contracts what can happen and runs immediately; turning it ON gets a card.

const { checkBounds, BOUNDS } = require('../../registry/src/bounds');
const { changeKey } = require('../../registry/src/drafts');

const INTENTS = ['budget_set', 'budget_change', 'pause_campaign', 'enable_campaign', 'add_negatives', 'autopilot_off', 'autopilot_on', 'question', 'unknown'];
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const SYSTEM = [
  'You turn a small-business owner\'s request about their Google Ads into ONE structured intent. You never decide what to do; code does.',
  'Return ONLY JSON: {"intent": one of ' + JSON.stringify(INTENTS) + ', "campaign": string|null, "amount_usd": number|null, "direction": "up"|"down"|null, "percent": number|null, "terms": [string], "category": "negatives"|"budgets"|"counting"|"all"|null, "question": string|null}',
  'budget_set = a specific daily amount; budget_change = up/down by amount or percent; add_negatives = stop showing for words/searches; pause/enable a named campaign; autopilot_off/on with a category or "all"; question = they are asking, not asking for a change; unknown otherwise.',
  'Use the campaign names from the list verbatim when the request clearly refers to one; null if unclear. Never invent numbers.',
].join('\n');

function matchCampaign(name, campaigns) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  const exact = campaigns.find((c) => c.name.toLowerCase() === n);
  if (exact) return exact;
  const contains = campaigns.filter((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()));
  return contains.length === 1 ? contains[0] : null;
}

/** Deterministic mapping: intent → draft (registry-shaped) or a reply. */
function mapIntent(intent, ctx, text) {
  const campaigns = ctx.campaigns || [];
  const one = (label) => (campaigns.length === 1 ? campaigns[0] : null) || (label ? matchCampaign(label, campaigns) : null);
  const askWhich = `Which campaign do you mean? You have: ${campaigns.map((c) => `"${c.name}"`).join(', ')}.`;

  if (intent.intent === 'autopilot_off') {
    const cats = intent.category && intent.category !== 'all' ? [intent.category] : ['negatives', 'budgets', 'counting'];
    return { immediate: { kind: 'autopilot_off', categories: cats }, reply: `Done. Autopilot is off for ${cats.length === 3 ? 'everything' : cats.join(' and ')}; we will ask before every change from now on.` };
  }
  if (intent.intent === 'autopilot_on') {
    const cats = intent.category && intent.category !== 'all' ? [intent.category] : ['negatives', 'budgets', 'counting'];
    return {
      draft: { tool_id: 'settings.autopilot_on', params: { categories: cats }, target: 'settings:autopilot', category: null,
        before: { line: `Autopilot asks first for ${cats.join(', ')}` }, after: { line: `Autopilot handles ${cats.join(', ')} on its own, within the safety limits, and everything stays reversible` },
        summary: `Turn autopilot on for ${cats.join(', ')}` },
      reply: 'Turning autopilot on expands what can happen without you, so it needs your tap; the card is in your approvals.',
    };
  }
  if (intent.intent === 'budget_set' || intent.intent === 'budget_change') {
    const c = one(intent.campaign);
    if (!c) return { reply: campaigns.length ? askWhich : 'We do not see any campaigns on this account yet.' };
    if (!(c.budget_daily_usd > 0) || !c.budget_resource) return { reply: `We do not have "${c.name}"'s budget details from Google yet; the next weekly check will pick them up.` };
    let target;
    if (intent.intent === 'budget_set') target = Number(intent.amount_usd);
    else if (intent.percent != null) target = c.budget_daily_usd * (1 + (intent.direction === 'down' ? -1 : 1) * Number(intent.percent) / 100);
    else if (intent.amount_usd != null) target = c.budget_daily_usd + (intent.direction === 'down' ? -1 : 1) * Number(intent.amount_usd);
    if (!Number.isFinite(target) || target <= 0) return { reply: `What daily amount would you like for "${c.name}"? It is ${usd(c.budget_daily_usd)} a day now.` };
    const maxUp = c.budget_daily_usd * (1 + BOUNDS.budget_max_pct_per_change / 100);
    const maxDown = Math.max(BOUNDS.budget_floor_daily_usd, c.budget_daily_usd * (1 - BOUNDS.budget_max_pct_per_change / 100));
    let bounded = Math.min(maxUp, Math.max(maxDown, target));
    bounded = Math.round(bounded * 100) / 100;
    const clipped = Math.abs(bounded - target) > 0.01;
    if (bounded === c.budget_daily_usd) return { reply: `"${c.name}" is already at ${usd(c.budget_daily_usd)} a day.` };
    const draft = {
      tool_id: 'ads.adjust_budget', params: { campaign_id: String(c.id), budget_resource: c.budget_resource, new_daily_usd: bounded, previous_daily_usd: c.budget_daily_usd },
      target: `campaign:${c.id}:budget`, category: 'budgets',
      before: { line: `"${c.name}" runs on ${usd(c.budget_daily_usd)} a day` },
      after: { line: `"${c.name}" runs on ${usd(bounded)} a day${clipped ? ` (you asked for ${usd(target)}; we move budgets at most ${BOUNDS.budget_max_pct_per_change}% at a time, so this is the first step)` : ''}` },
      summary: `${bounded > c.budget_daily_usd ? 'Raise' : 'Lower'} "${c.name}" daily budget ${usd(c.budget_daily_usd)} → ${usd(bounded)}`,
    };
    return { draft, reply: clipped ? `Drafted: ${draft.summary}. You asked for ${usd(target)}; budgets move at most ${BOUNDS.budget_max_pct_per_change}% per change, so this is the first step and we can go again next week. The card is in your approvals.` : `Drafted: ${draft.summary}. The card is in your approvals; nothing changes until you tap it.` };
  }
  if (intent.intent === 'pause_campaign' || intent.intent === 'enable_campaign') {
    const c = one(intent.campaign);
    if (!c) return { reply: campaigns.length ? askWhich : 'We do not see any campaigns on this account yet.' };
    if (intent.intent === 'enable_campaign' && !(ctx.pausedByUs && ctx.pausedByUs.has(String(c.id)))) {
      return { reply: `We can only switch on campaigns we paused ourselves. "${c.name}" was paused in Google Ads directly, so it needs enabling there.` };
    }
    const pause = intent.intent === 'pause_campaign';
    const draft = {
      tool_id: pause ? 'ads.pause_campaign' : 'ads.enable_campaign', params: { campaign_id: String(c.id) }, target: `campaign:${c.id}:status`, category: null,
      before: { line: pause ? `"${c.name}" is running` : `"${c.name}" is paused` }, after: { line: pause ? `"${c.name}" is paused; one tap turns it back on` : `"${c.name}" is running again` },
      summary: `${pause ? 'Pause' : 'Switch on'} "${c.name}"`,
    };
    return { draft, reply: `Drafted: ${draft.summary}. The card is in your approvals.` };
  }
  if (intent.intent === 'add_negatives') {
    const terms = (intent.terms || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, BOUNDS.negatives_max_per_change);
    if (!terms.length) return { reply: 'Which words or searches should we stop showing for?' };
    const c = one(intent.campaign) || (campaigns.length === 1 ? campaigns[0] : null);
    if (!c) return { reply: `${askWhich} Or say "all campaigns".` };
    const converting = terms.filter((t) => ctx.convertingTerms && ctx.convertingTerms.has(t));
    const keep = terms.filter((t) => !converting.includes(t));
    if (!keep.length) return { reply: `"${converting.join('", "')}" brought you customers in the last 90 days, so we will not exclude ${converting.length === 1 ? 'it' : 'them'}.` };
    const draft = {
      tool_id: 'ads.add_negative_keywords', params: { campaign_id: String(c.id), terms: keep.map((t) => ({ text: t, match_type: 'phrase' })) }, target: `campaign:${c.id}:negatives`, category: 'negatives',
      before: { line: `Ads in "${c.name}" can show for searches containing ${keep.map((t) => `"${t}"`).join(', ')}` }, after: { line: `Those searches are excluded; everything else keeps running` },
      summary: `Exclude ${keep.length} search${keep.length === 1 ? '' : 'es'} from "${c.name}"`,
    };
    return { draft, reply: `Drafted: ${draft.summary}.${converting.length ? ` We left out "${converting.join('", "')}" because ${converting.length === 1 ? 'it' : 'they'} brought you customers recently.` : ''} The card is in your approvals.` };
  }
  if (intent.intent === 'question') return { question: intent.question || text };
  return { reply: 'We cannot do that one automatically yet. We have noted it for the team, and a person will look at it.', unanswered: true };
}

async function interpretRequest({ text, ctx, generate }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return { intent: { intent: 'unknown' }, draft: null, reply: 'Tell us what you would like changed.', unanswered: false };
  let intent = { intent: 'unknown' };
  if (generate) {
    try {
      const raw = await generate({ system: SYSTEM, prompt: `Campaigns: ${JSON.stringify((ctx.campaigns || []).map((c) => c.name))}\nRequest: ${clean}` });
      const parsed = JSON.parse(String(raw).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
      if (INTENTS.includes(parsed.intent)) intent = parsed;
    } catch { intent = { intent: 'unknown' }; }
  }
  const mapped = mapIntent(intent, ctx, clean);
  if (mapped.draft && mapped.draft.tool_id !== 'settings.autopilot_on') {
    // Registry bounds re-check (defence in depth) + canonical key for dedup.
    const bound = checkBounds({ ...mapped.draft }, ctx.bounds || { account: {}, campaign: (id) => (ctx.campaigns || []).find((c) => String(c.id) === String(id)), converting_terms: ctx.convertingTerms || new Set() });
    if (bound) return { intent, draft: null, reply: `We cannot draft that one: ${bound}.`, unanswered: false };
    mapped.draft.change_key = changeKey(mapped.draft.tool_id, mapped.draft.target, mapped.draft.params);
  }
  if (mapped.draft) mapped.draft.change_key = mapped.draft.change_key || changeKey(mapped.draft.tool_id, mapped.draft.target, mapped.draft.params);
  return { intent, draft: mapped.draft || null, immediate: mapped.immediate || null, question: mapped.question || null, reply: mapped.reply || null, unanswered: !!mapped.unanswered };
}

module.exports = { interpretRequest, mapIntent, matchCampaign, INTENTS };
