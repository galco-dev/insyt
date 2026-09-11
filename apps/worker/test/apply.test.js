const assert = require('node:assert');
const { test } = require('node:test');
const { scanAndApply } = require('../src/apply');

test('apply loop: reads run_id through the finding join (changes has no run_id column)', async () => {
  const calls = [];
  const db = {
    select: async (table, query) => {
      calls.push({ table, query });
      if (table === 'changes') {
        assert.ok(!/[,&]run_id/.test(query), 'must not select a bare run_id column');
        assert.ok(query.includes('finding:findings(run_id)'));
        return [{ id: 'c1', tenant_id: 't1', tool_id: 'ads.add_negative_keywords', params: {}, finding_id: 'f1', finding: { run_id: 'run9' } }];
      }
      return [];
    },
    insert: async (table, rows) => { calls.push({ table, rows }); return rows.map((r, i) => ({ id: `${table}-${i}`, ...r })); },
    update: async () => {},
  };
  const r = await scanAndApply({
    db,
    makeApi: async () => { throw new Error('no google connection'); }, // defers, exercises the changeset insert path only
    makeCtx: async () => ({}),
    now: () => Date.parse('2026-08-27T00:00:00Z'),
  });
  assert.strictEqual(r.tenants, 1);
  const cs = calls.find((c) => c.table === 'changesets');
  assert.strictEqual(cs.rows[0].run_id, 'run9');
});

test('apply loop (fix plan move 9): a moved budget becomes a fresh proposal; a refusal gets a plain receipt with the reason', async () => {
  const calls = [];
  const rows = [
    { id: 'b1', tenant_id: 't1', tool_id: 'ads.adjust_budget', params: { campaign_id: '11', new_daily_usd: 18, previous_daily_usd: 25 }, before: { line: 'Runs on $25 a day' }, finding_id: null, finding: null, summary_text: 'Lower the budget' },
    { id: 'n1', tenant_id: 't1', tool_id: 'ads.add_negative_keywords', params: { campaign_id: '11', terms: [{ text: 'x', match_type: 'exact' }] }, finding_id: null, finding: null, summary_text: 'Exclude 1 search' },
  ];
  const db = {
    select: async (table, query, opts) => { calls.push({ table, query }); if (table === 'changes' && /status=eq\.approved/.test(query)) return rows; return opts && opts.single ? null : []; },
    insert: async (table, list) => { calls.push({ table, rows: list }); return list.map((r, i) => ({ id: `${table}-${i}`, ...r })); },
    update: async (table, query, patch) => { calls.push({ table, query, patch }); },
  };
  const api = { 'ads.add_negative_keywords': async () => { const e = new Error('PERMISSION_DENIED: user does not have access'); throw e; } };
  const r = await scanAndApply({
    db, makeApi: async () => api,
    makeCtx: async () => ({ campaign: (id) => (String(id) === '11' ? { id: '11', budget_daily_usd: 30 } : null), account: { daily_budget_total_usd: 100, weekly_budget_delta_pct: 0, platform_min_daily_usd: 1 }, convertingTerms: new Set() }),
    now: () => Date.parse('2026-09-12T00:00:00Z'),
  });
  const drift = calls.find((c) => c.table === 'changes' && c.query && /id=eq\.b1/.test(c.query) && c.patch);
  assert.strictEqual(drift.patch.status, 'proposed');
  assert.strictEqual(drift.patch.ask_reason, 'You changed this to $30 since we drafted it. Still want $18?');
  assert.strictEqual(drift.patch.params.previous_daily_usd, 30);
  assert.strictEqual(r.failed, 1, 'the negative failed at Google');
  const receipt = calls.find((c) => c.table === 'ledger' && c.rows && c.rows[0].event === 'fix_failed');
  assert.ok(receipt, 'a fix_failed ledger line');
  assert.strictEqual(receipt.rows[0].change_id, 'n1');
  assert.match(receipt.rows[0].summary_text, /^Not applied: "Exclude 1 search"\. Google says this account does not allow the change from our side\./);
});

test('apply loop: nothing approved → no work', async () => {
  const db = { select: async () => [] };
  assert.deepStrictEqual(await scanAndApply({ db, makeApi: async () => ({}), makeCtx: async () => ({}) }), { tenants: 0, applied: 0, failed: 0 });
});
