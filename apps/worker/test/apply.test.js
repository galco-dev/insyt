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

test('apply loop: nothing approved → no work', async () => {
  const db = { select: async () => [] };
  assert.deepStrictEqual(await scanAndApply({ db, makeApi: async () => ({}), makeCtx: async () => ({}) }), { tenants: 0, applied: 0, failed: 0 });
});
