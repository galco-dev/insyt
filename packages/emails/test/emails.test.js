const assert = require('node:assert');
const { test } = require('node:test');
const { mintLink, redeemLink, TTL_HOURS } = require('../src/magic-links');
const { TEMPLATES, renderTemplate } = require('../src/templates');

function mkStore() {
  const rows = [];
  let id = 1;
  return {
    rows,
    insertLink: (r) => rows.push({ id: id++, ...r }),
    findByHash: (h) => rows.find((r) => r.token_hash === h) || null,
    markUsed: (rowId, at) => { rows.find((r) => r.id === rowId).used_at = at; },
  };
}

const NOW = Date.parse('2026-08-19T00:00:00Z');

test('magic links: token never stored, single-use, expiring, purpose TTLs', () => {
  const store = mkStore();
  const { token, url } = mintLink({ tenantId: 'tn1', purpose: 'view_report', targetId: 'rep1', baseUrl: 'https://app.tryinsyt.com', now: NOW }, store);
  assert.ok(url.includes(token));
  assert.ok(!JSON.stringify(store.rows).includes(token), 'only the hash is stored');

  const first = redeemLink(token, NOW + 1000, store);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.link.purpose, 'view_report');
  const second = redeemLink(token, NOW + 2000, store);
  assert.deepStrictEqual(second, { ok: false, reason: 'used' }, 'single-use');

  const store2 = mkStore();
  const { token: t2 } = mintLink({ tenantId: 'tn1', purpose: 'view_report', baseUrl: 'x', now: NOW }, store2);
  assert.strictEqual(redeemLink(t2, NOW + 73 * 3600 * 1000, store2).reason, 'expired', '72h report links');
  assert.strictEqual(TTL_HOURS.approve_all, 168, 'approve links live 7 days');
  assert.strictEqual(redeemLink('garbage', NOW, mkStore()).reason, 'unknown');
});

test('template set: the §12 catalogue is present with correct streams', () => {
  assert.ok(TEMPLATES.length >= 25, `expected >=25 templates, got ${TEMPLATES.length}`);
  const ids = TEMPLATES.map((t) => t.id);
  for (const required of ['audit_ready', 'report_weekly_core', 'report_weekly_autopilot', 'fix_verified_48h', 'revert_notice', 'tag_verified', 'first_conversion', 'launch_live', 'reconnect_needed', 'card_failed_grace', 'milestone_smart_bidding', 'graduation_prompt', 'monthly_pulse']) {
    assert.ok(ids.includes(required), `missing ${required}`);
  }
  assert.ok(TEMPLATES.filter((t) => t.id.startsWith('tag_guide_')).length === 5, 'one guide per platform');
  assert.strictEqual(TEMPLATES.find((t) => t.id === 'report_weekly_core').stream, 'report');
  assert.strictEqual(TEMPLATES.find((t) => t.id === 'reconnect_needed').stream, 'transactional');
});

test('single-CTA rule: every rendered template has at most one link button', () => {
  const vars = {
    issue_count: 3, site: 'x.com', health_score: 72, waste_monthly: '$340', report_url: 'u', amount: '$20',
    headline: 'h', exec_summary: 'e', pending_count: 2, approve_url: 'u', applied_count: 4, deep_synthesis: 'd',
    fix_summary: 'f', verify_detail: 'v', reverted_at: 'today', revert_url: 'u', guide_url: 'u', video_url: 'u',
    handoff_url: 'u', pages_checked: 4, corrective_line: 'c', conversion_line: 'c', stage_line: 's', resume_url: 'u',
    billing_url: 'u', launched_at: 'today', dashboard_url: 'u', reconnect_url: 'u', attempt: 1, next_retry_days: 3,
    portal_url: 'u', conversions_30d: 31, plan_url: 'u', pulse_line: 'p', title: 't', app_url: 'u', severity: 'warning',
  };
  for (const t of TEMPLATES) {
    const { html, subject } = renderTemplate(t.id, vars);
    const buttons = (html.match(/display:inline-block;padding:12px 24px/g) || []).length;
    assert.ok(buttons <= 1, `${t.id} has ${buttons} CTAs`);
    assert.ok(subject.length > 0 && html.includes('<!doctype html>'));
  }
});
