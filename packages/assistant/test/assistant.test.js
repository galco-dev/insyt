const assert = require('node:assert');
const { test } = require('node:test');
const { interpretRequest, mapIntent, matchCampaign } = require('../src/interpret');
const { routeQuestion } = require('../src/tools');
const { createAssistant, REQUEST_HINT } = require('../src/chat');

const campaigns = [
  { id: '11', name: 'Brand - Dubai', status: 'enabled', budget_daily_usd: 25, budget_resource: 'customers/1/campaignBudgets/1' },
  { id: '22', name: 'Gel nails', status: 'enabled', budget_daily_usd: 40, budget_resource: 'customers/1/campaignBudgets/2' },
];
const ctx = { campaigns, convertingTerms: new Set(['gel nails dubai']), pausedByUs: new Set(['22']), autopilot: { negatives: true, budgets: false, counting: false },
  bounds: { account: { daily_budget_total_usd: 65 }, campaign: (id) => campaigns.find((c) => c.id === String(id)), converting_terms: new Set(['gel nails dubai']), reverted_30d: 0 } };
const gen = (intent) => async () => JSON.stringify(intent);

test('budget_set: bounded to 20% per change with the bound stated; identical → no card', async () => {
  const r = await interpretRequest({ text: 'set the brand budget to 10 a day', ctx, generate: gen({ intent: 'budget_set', campaign: 'Brand - Dubai', amount_usd: 10 }) });
  assert.strictEqual(r.draft.tool_id, 'ads.adjust_budget');
  assert.strictEqual(r.draft.params.new_daily_usd, 20, 'clipped to -20%');
  assert.match(r.reply, /first step/);
  assert.ok(r.draft.change_key);
  const same = await interpretRequest({ text: 'set brand to 25', ctx, generate: gen({ intent: 'budget_set', campaign: 'Brand - Dubai', amount_usd: 25 }) });
  assert.strictEqual(same.draft, null);
  assert.match(same.reply, /already at/);
});

test('budget_change by percent/amount; ambiguous campaign asks which', async () => {
  const up = await interpretRequest({ text: 'raise gel nails by 10%', ctx, generate: gen({ intent: 'budget_change', campaign: 'Gel nails', direction: 'up', percent: 10 }) });
  assert.strictEqual(up.draft.params.new_daily_usd, 44);
  const amb = await interpretRequest({ text: 'raise the budget', ctx, generate: gen({ intent: 'budget_change', campaign: null, direction: 'up', amount_usd: 5 }) });
  assert.strictEqual(amb.draft, null);
  assert.match(amb.reply, /Which campaign/);
});

test('negatives: converting terms are never excluded; pause/enable cards; enable only for campaigns we paused', async () => {
  const neg = await interpretRequest({ text: 'stop showing for free nails and gel nails dubai', ctx, generate: gen({ intent: 'add_negatives', campaign: 'Gel nails', terms: ['free nails', 'gel nails dubai'] }) });
  assert.deepStrictEqual(neg.draft.params.terms, [{ text: 'free nails', match_type: 'phrase' }]);
  assert.match(neg.reply, /brought you customers/);
  const pause = await interpretRequest({ text: 'pause brand', ctx, generate: gen({ intent: 'pause_campaign', campaign: 'Brand - Dubai' }) });
  assert.strictEqual(pause.draft.tool_id, 'ads.pause_campaign');
  const en = await interpretRequest({ text: 'switch brand back on', ctx, generate: gen({ intent: 'enable_campaign', campaign: 'Brand - Dubai' }) });
  assert.strictEqual(en.draft, null);
  assert.match(en.reply, /only switch on campaigns we paused/);
  const en2 = await interpretRequest({ text: 'switch gel nails on', ctx, generate: gen({ intent: 'enable_campaign', campaign: 'Gel nails' }) });
  assert.strictEqual(en2.draft.tool_id, 'ads.enable_campaign');
});

test('consent asymmetry: autopilot off is immediate; autopilot on is a card; unknown → unanswered', async () => {
  const off = await interpretRequest({ text: 'stop autopilot on everything', ctx, generate: gen({ intent: 'autopilot_off', category: 'all' }) });
  assert.deepStrictEqual(off.immediate, { kind: 'autopilot_off', categories: ['negatives', 'budgets', 'counting'] });
  const on = await interpretRequest({ text: 'turn autopilot on for budgets', ctx, generate: gen({ intent: 'autopilot_on', category: 'budgets' }) });
  assert.strictEqual(on.draft.tool_id, 'settings.autopilot_on');
  const unk = await interpretRequest({ text: 'make my logo bigger', ctx, generate: gen({ intent: 'unknown' }) });
  assert.deepStrictEqual({ d: unk.draft, u: unk.unanswered }, { d: null, u: true });
  const noModel = await interpretRequest({ text: 'anything', ctx, generate: null });
  assert.strictEqual(noModel.unanswered, true);
  assert.strictEqual(matchCampaign('brand', campaigns).id, '11');
  assert.strictEqual(matchCampaign('nails', campaigns).id, '22');
  assert.strictEqual(matchCampaign('a', [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }]), null, 'ambiguous → null');
});

test('routeQuestion picks tool payloads by keyword; REQUEST_HINT separates asks from questions', () => {
  assert.ok(routeQuestion('how much have I spent this month').includes('spend'));
  assert.ok(routeQuestion('what did you change last week').includes('history'));
  assert.ok(REQUEST_HINT.test('lower the brand budget to 20') && !REQUEST_HINT.test('how much did I spend'));
});

function fakeDb(state) {
  const writes = [];
  return {
    writes, state,
    select: async (table, query, opts) => {
      if (table === 'model_usage') return state.usage || null;
      if (table === 'conversations') return state.conv ? { id: state.conv } : null;
      if (table === 'messages') return state.messages || [];
      if (table === 'campaigns') return campaigns.map((c) => ({ google_campaign_id: c.id, name: c.name, status: c.status, budget_daily_usd: c.budget_daily_usd, budget_resource: c.budget_resource, last_seen_at: '2026-08-26T00:00:00Z' }));
      if (table === 'changes') return opts && opts.single ? null : [];
      if (table === 'autopilot_settings') return { categories: { negatives: true } };
      return opts && opts.single ? null : [];
    },
    insert: async (table, rows) => { writes.push({ table, rows }); return rows.map((r, i) => ({ id: `${table}-${i}`, ...r })); },
    update: async (table, query, patch) => { writes.push({ table, patch }); },
    upsert: async (table, rows) => { writes.push({ table, rows }); },
  };
}
const { createReadTools } = require('../src/tools');

test('chat turn: request → card with the user\'s words + ledger; question → grounded answer from routed tools', async () => {
  const state = { conv: 'c1' };
  const db = fakeDb(state);
  const calls = [];
  const generate = async ({ system, prompt }) => {
    calls.push(system.slice(0, 30));
    if (/structured intent/.test(system)) return JSON.stringify({ intent: 'budget_set', campaign: 'Brand - Dubai', amount_usd: 22 });
    return 'As of 26 August you have two campaigns running. Brand - Dubai is on $25 a day.';
  };
  const a = createAssistant({ db, generate, modelId: 'claude-fable-5', tools: createReadTools({ db }) });
  const r = await a.turn({ tenantId: 't1', text: 'set the Brand budget to 22 a day' });
  assert.strictEqual(r.card.summary, 'Lower "Brand - Dubai" daily budget $25 → $22');
  const ch = db.writes.find((w) => w.table === 'changes').rows[0];
  assert.deepStrictEqual({ st: ch.status, actor: ch.actor, req: ch.request_text }, { st: 'proposed', actor: 'user_via_chat', req: 'set the Brand budget to 22 a day' });
  assert.ok(db.writes.some((w) => w.table === 'ledger' && w.rows[0].event === 'change_requested'));
  const msgs = db.writes.filter((w) => w.table === 'messages').map((w) => w.rows[0]);
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.strictEqual(msgs[1].model_version, 'claude-fable-5');

  const qn = await a.turn({ tenantId: 't1', text: 'which campaigns are running?' });
  assert.match(qn.reply, /Brand - Dubai/);
  assert.strictEqual(qn.card, null);
  assert.strictEqual(calls.length, 2);
});

test('usage metering: heads-up at 80% once; at 100% without consent the assistant rests (no model call); consent records + ledgers', async () => {
  const state = { conv: 'c1', usage: { cost_usd: 25, billing_consented_at: null, notified_80_at: null } };
  const db = fakeDb(state);
  let modelCalls = 0;
  const generate = async () => { modelCalls += 1; return 'ok'; };
  const a = createAssistant({ db, generate, modelId: 'm', tools: createReadTools({ db }) });
  const r = await a.turn({ tenantId: 't1', text: 'how are things' });
  assert.strictEqual(r.system_cards[0].kind, 'usage_heads_up');
  assert.ok(db.writes.some((w) => w.table === 'model_usage' && w.rows[0].notified_80_at));
  state.usage = { cost_usd: 31, billing_consented_at: null };
  const rest = await a.turn({ tenantId: 't1', text: 'how are things' });
  assert.strictEqual(rest.system_cards[0].kind, 'usage_consent');
  assert.strictEqual(rest.model_version, null);
  assert.strictEqual(modelCalls, 1, 'no model call once exhausted');
  const c = await a.consent('t1');
  assert.strictEqual(c.ok, true);
  assert.ok(db.writes.some((w) => w.table === 'model_usage' && w.rows[0].billing_consented_at));
  assert.ok(db.writes.some((w) => w.table === 'ledger' && /billed at cost/.test(w.rows[0].summary_text)));
  state.usage = { cost_usd: 31, billing_consented_at: '2026-08-27T00:00:00Z' };
  const again = await a.turn({ tenantId: 't1', text: 'how are things' });
  assert.strictEqual(again.model_version, 'm');
});

test('chat: no model configured → honest unavailable reply, nothing else touched', async () => {
  const db = fakeDb({ conv: 'c1' });
  const a = createAssistant({ db, generate: null, tools: createReadTools({ db }) });
  const r = await a.turn({ tenantId: 't1', text: 'hello' });
  assert.match(r.reply, /not available/);
  assert.ok(!db.writes.some((w) => w.table === 'changes'));
});
