const assert = require('node:assert');
const { test } = require('node:test');
const { drainQueuedEmails, FROM } = require('../src/sender');

function mkDb({ queued, report }) {
  const calls = [];
  return {
    calls,
    select: async (table, query, opts) => {
      calls.push(['select', table, query]);
      if (table === 'emails') return queued;
      if (table === 'reports') return report;
      return opts && opts.single ? null : [];
    },
    update: async (table, query, patch) => calls.push(['update', table, query, patch]),
    insert: async (table, rows) => calls.push(['insert', table, rows]),
  };
}

function mkFetch(status = 200) {
  const sent = [];
  const impl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: status < 400, status, json: async () => ({ id: 'em_1' }) };
  };
  impl.sent = sent;
  return impl;
}

test('sender: report row sends frozen html on the report stream with unsubscribe header', async () => {
  const db = mkDb({
    queued: [{ id: 'e1', tenant_id: 'tn', report_id: 'rep1', template_id: 'report_weekly_core', to_email: 'max@x.com', stream: 'report', payload: {} }],
    report: { html_email: '<!doctype html><p>frozen</p>', type: 'weekly' },
  });
  const f = mkFetch();
  const r = await drainQueuedEmails({ db, apiKey: 'k', baseUrl: 'https://app.tryinsyt.com', fetchImpl: f });
  assert.deepStrictEqual(r, { sent: 1, failed: 0 });
  assert.strictEqual(f.sent[0].from, FROM.report);
  assert.strictEqual(f.sent[0].html, '<!doctype html><p>frozen</p>');
  assert.ok(f.sent[0].headers['List-Unsubscribe']);
  const patch = db.calls.find((c) => c[0] === 'update' && c[1] === 'emails')[3];
  assert.strictEqual(patch.status, 'sent');
});

test('sender: transactional row renders its template from payload, no unsubscribe header', async () => {
  const db = mkDb({
    queued: [{ id: 'e2', tenant_id: 'tn', report_id: null, template_id: 'reconnect_needed', to_email: 'max@x.com', stream: 'transactional', payload: { reconnect_url: 'https://x/r' } }],
  });
  const f = mkFetch();
  const r = await drainQueuedEmails({ db, apiKey: 'k', baseUrl: 'https://x', fetchImpl: f });
  assert.deepStrictEqual(r, { sent: 1, failed: 0 });
  assert.strictEqual(f.sent[0].from, FROM.transactional);
  assert.match(f.sent[0].subject, /reconnect/i);
  assert.ok(f.sent[0].html.includes('https://x/r'));
  assert.strictEqual(f.sent[0].headers, undefined);
});

test('sender: failure marks bounced + audit row, drain continues', async () => {
  const db = mkDb({
    queued: [
      { id: 'e3', tenant_id: 'tn', report_id: null, template_id: 'reconnect_needed', to_email: '', stream: 'transactional', payload: {} },
      { id: 'e4', tenant_id: 'tn', report_id: null, template_id: 'reconnect_needed', to_email: 'ok@x.com', stream: 'transactional', payload: { reconnect_url: 'u' } },
    ],
  });
  const f = mkFetch();
  const r = await drainQueuedEmails({ db, apiKey: 'k', baseUrl: 'https://x', fetchImpl: f });
  assert.deepStrictEqual(r, { sent: 1, failed: 1 });
  assert.ok(db.calls.some((c) => c[0] === 'update' && JSON.stringify(c).includes('bounced')));
  assert.ok(db.calls.some((c) => c[0] === 'insert' && c[1] === 'audit_log'));
});
