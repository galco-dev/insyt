const assert = require('node:assert');
const { test } = require('node:test');
const { judgePulse } = require('../src/pulse');

const now = Date.parse('2026-08-27T09:00:00Z');
const days = (spend, conv) => spend.map((s, i) => ({ date: `2026-08-${String(19 + i).padStart(2, '0')}`, spend_usd: s, conversions: conv[i] }));

test('pulse: quiet account → no alerts (today partial ignored)', () => {
  const pulse = { days: days([100, 100, 100, 100, 100, 100, 100, 100, 5], [2, 2, 2, 2, 2, 2, 2, 2, 0]), disapproved: [] };
  assert.deepStrictEqual(judgePulse({ pulse, now }), []);
});

test('pulse: spend spike, silence, conversion flatline, disapprovals', () => {
  const spike = { days: days([100, 100, 100, 100, 100, 100, 100, 260, 0], [2, 2, 2, 2, 2, 2, 2, 2, 0]), disapproved: [] };
  const a = judgePulse({ pulse: spike, now });
  assert.deepStrictEqual(a.map((x) => x.kind), ['spend_spike']);
  assert.strictEqual(a[0].trigger_run, true);
  assert.strictEqual(a[0].detail.multiple, 2.6);

  const silence = { days: days([100, 100, 100, 100, 100, 100, 100, 4, 0], [2, 2, 2, 2, 2, 2, 2, 0, 0]), disapproved: [] };
  assert.deepStrictEqual(judgePulse({ pulse: silence, now }).map((x) => x.kind), ['spend_silence']);

  const flat = { days: days([100, 100, 100, 100, 100, 100, 100, 100, 0], [2, 2, 2, 2, 2, 0, 0, 0, 0]), disapproved: [] };
  const f = judgePulse({ pulse: flat, now });
  assert.deepStrictEqual(f.map((x) => [x.kind, x.severity]), [['conv_flatline', 'critical']]);
  assert.strictEqual(f[0].detail.spend_usd, 300);

  const dis = { days: [], disapproved: [{ ad_id: '1', campaign_id: 'c1', campaign_name: 'Brand' }, { ad_id: '2', campaign_id: 'c1', campaign_name: 'Brand' }] };
  const d = judgePulse({ pulse: dis, now });
  assert.deepStrictEqual({ k: d[0].kind, ref: d[0].campaign_ref, sev: d[0].severity }, { k: 'disapproval', ref: 'c1', sev: 'info' });
  assert.match(d[0].title, /2 ads disapproved .* "Brand"/);
});

test('pulse: tiny accounts do not page; thresholds are config', () => {
  const tiny = { days: days([5, 5, 5, 5, 5, 5, 5, 20, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]), disapproved: [] };
  assert.deepStrictEqual(judgePulse({ pulse: tiny, now }), []);
  assert.strictEqual(judgePulse({ pulse: tiny, now, thresholds: { spike_min_usd: 10 } })[0].kind, 'spend_spike');
});
