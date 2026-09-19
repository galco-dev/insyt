// Tracking brief B5: the dataLayer rows are pure, so they are tested here
// without a browser. api.js wires them to sessionStorage and window.
const assert = require('node:assert');
const { test } = require('node:test');

const load = () => import('../client/src/lib/datalayer.mjs');

// A tab's storage: survives navigations and reloads, gone when the tab closes.
const tab = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), map: m }; };

test('pushDL is inert in demo mode', async () => {
  const { buildRow } = await load();
  assert.equal(buildRow('paste', { site_host: 'glowstudio.com' }, { demo: true, attribution: { src: 'launch' } }), null);
  assert.ok(buildRow('paste', { site_host: 'glowstudio.com' }, { demo: false }));
});

test('src, trade and journey survive from /app/start to the post-payment push', async () => {
  const { buildRow, journeyOf } = await load();
  // Landing on /app/start?url=...&src=launch&trade=dentists: api.js keeps these for the tab.
  const store = tab();
  const landing = new URLSearchParams('url=smile.com&src=launch&trade=dentists&gclid=abc123');
  for (const k of ['src', 'trade', 'gclid']) store.set(`insyt_${k}`, landing.get(k));
  const attribution = () => ({ src: store.get('insyt_src'), trade: store.get('insyt_trade') });
  // Two redirects later (Google, then Stripe) the same tab pushes the payment.
  const first = buildRow('paste', { site_host: 'smile.com' }, { attribution: attribution() });
  const last = buildRow('report_unlocked', { transaction_id: 'pi_1', value: 20, currency: 'USD' }, { attribution: attribution(), userId: 'tenant-1' });
  assert.deepStrictEqual([first.journey, first.src, first.trade], ['B', 'launch', 'dentists']);
  assert.deepStrictEqual([last.journey, last.src, last.trade, last.user_id, last.value], ['B', 'launch', 'dentists', 'tenant-1', 20]);
  assert.equal(journeyOf({}), 'A');
  assert.equal(journeyOf({ src: 'blog' }), 'A');
  // The click id never rides in a row.
  assert.ok(!('gclid' in last));
});

test('a payment event is pushed once, and not again on reload', async () => {
  const { pushOnce, buildRow } = await load();
  const store = tab();
  const layer = [];
  const push = () => { layer.push(buildRow('report_unlocked', { transaction_id: 'pi_9', value: 20, currency: 'USD' })); return true; };
  assert.equal(pushOnce(store, 'pi_9', push), true);
  assert.equal(pushOnce(store, 'pi_9', push), false);
  // A reload keeps sessionStorage: a fresh page with the same backing store still declines.
  const reloaded = { get: (k) => store.map.get(k) || null, set: (k, v) => store.map.set(k, v) };
  assert.equal(pushOnce(reloaded, 'pi_9', push), false);
  assert.equal(layer.length, 1);
  // A different transaction is its own push.
  assert.equal(pushOnce(store, 'pi_10', push), true);
});

test('nothing pushed contains an @', async () => {
  const { buildRow } = await load();
  const row = buildRow('signin', { method: 'google', email: 'owner@example.com', note: 'mail me at max@x.io', nested: { email: 'a@b.c' } }, { attribution: { src: 'launch', trade: 'x@y' }, userId: 'tenant-1' });
  assert.equal(row.method, 'google');
  assert.ok(!('email' in row));
  assert.ok(!('note' in row));
  assert.ok(!('nested' in row));
  assert.ok(!JSON.stringify(row).includes('@'));
});

test('a profession page\'s src=launch-dentists counts as the launch journey', async () => {
  const { journeyOf } = await load();
  assert.equal(journeyOf({ src: 'launch-dentists' }), 'B');
  assert.equal(journeyOf({ src: 'launch' }), 'B');
  assert.equal(journeyOf({ src: 'launchpad' }), 'A');
});
