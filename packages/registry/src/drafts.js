// draft_pass — engine-spec §6.1 / §4.3 / §7.3. Turns this run's findings into
// drafted changes through the registry, applies the bounds, decides which
// drafts autopilot may apply and which become ask-first cards, and dedups
// against what is already pending, recently applied, or standing-excepted.
// Pure: no I/O. The worker persists the result (stores.saveDrafts).
//
// draftChanges({ findings, ctx, state, autopilot, exceptions, inflight, recent })
//   autopilot   { negatives: bool, budgets: bool, counting: bool }   (owner's 3 toggles)
//   exceptions  Set<change_key>     standing exceptions (§4.5)
//   inflight    Set<target>         resources with a pending/approved human card (§7.3: one change in flight per resource)
//   recent      Set<change_key>     applied in the last 30 days (never re-propose an identical fix)
// -> { drafts: [...], skipped: [{ rule_id, entity_key, reason }] }

const crypto = require('node:crypto');
const { byRule } = require('./registry');
const { checkBounds, pairBudgetMoves } = require('./bounds');

const AUTOPILOT_CATEGORIES = ['negatives', 'budgets', 'counting'];

function changeKey(toolId, target, params) {
  const canon = JSON.stringify(params, Object.keys(params || {}).sort());
  const h = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 10);
  return `${toolId}:${target}:${h}`;
}

function draftChanges({ findings, ctx, state, autopilot = {}, exceptions = new Set(), inflight = new Set(), recent = new Set() }) {
  const drafts = [];
  const skipped = [];
  const seenTargets = new Set();

  for (const f of findings) {
    const row = byRule[f.rule_id];
    if (!row) continue;
    if (f.status === 'suspect') { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'suspect: reverted before, identical fix not re-proposed' }); continue; }
    if (f.fix && f.fix.available === false && f.rule_id !== 'watch.change_regressed') { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'fix not available' }); continue; }

    let shapes;
    try { shapes = row.derive(f, ctx) || []; } catch (e) { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: `derive failed: ${e.message}` }); continue; }
    if (!shapes.length) { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'nothing safely derivable' }); continue; }

    for (const s of shapes) {
      const toolId = s.tool_id || row.tool_id;
      const key = changeKey(toolId, s.target, s.params);
      if (exceptions.has(key)) { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'standing exception' }); continue; }
      if (recent.has(key)) { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'identical change applied recently' }); continue; }
      if (inflight.has(s.target) || seenTargets.has(s.target)) { skipped.push({ rule_id: f.rule_id, entity_key: f.entity_key, reason: 'a change is already in flight for this resource' }); continue; }
      seenTargets.add(s.target);
      drafts.push({
        finding_id: f.finding_id, rule_id: f.rule_id, entity_key: f.entity_key,
        tool_id: toolId, params: s.params, target: s.target, change_key: key,
        category: row.category, before: s.before, after: s.after, summary: s.summary,
        money_impact_usd: s.money_impact_usd ?? null,
        watch: row.watch, baseline: row.baseline ? row.baseline(f, ctx) : {},
        reverts_change_id: s.reverts_change_id || null,
        mode: 'ask', reason: null,
      });
    }
  }

  // Reallocate-only: raises need cuts in the same run to be autopilot-eligible
  // (a raise may shrink to the freed amount, so keys are recomputed after).
  pairBudgetMoves(drafts);
  for (const d of drafts) d.change_key = changeKey(d.tool_id, d.target, d.params);

  // Autopilot eligibility + bounds. Bounds failures on ask-first drafts still
  // become cards (a human can decide) but carry the reason; bounds failures
  // never reach autopilot.
  const sameRun = { budgets: 0, counting: 0 };
  for (const d of drafts) {
    const bound = checkBounds(d, { ...state, same_run: sameRun });
    const eligible = d.category && AUTOPILOT_CATEGORIES.includes(d.category) && !!autopilot[d.category];
    if (bound) {
      d.mode = 'ask'; d.reason = bound;
    } else if (!eligible) {
      d.mode = 'ask'; d.reason = d.category ? 'autopilot off for this category' : 'always asks';
    } else if (d.tool_id === 'ads.adjust_budget' && d.funded === false) {
      d.mode = 'ask'; d.reason = 'a raise without a matching cut needs your explicit yes';
    } else {
      d.mode = 'autopilot';
    }
    if (d.category === 'budgets' && d.mode === 'autopilot') sameRun.budgets += 1;
    if (d.category === 'counting' && d.mode === 'autopilot') sameRun.counting += 1;
    delete d.funded;
  }

  return { drafts, skipped };
}

module.exports = { draftChanges, changeKey, AUTOPILOT_CATEGORIES };
