// The assistant — engine-spec §7. A conversational client of the same
// pipeline: it reads stored data (tools.js), drafts cards (interpret.js),
// and never executes anything. Chat is never the system of record (§7.4.1):
// transcripts could vanish with zero account-state loss.
//
//   createAssistant({ db, generate, modelId, tools, dashStore, usage })
//     .turn({ tenantId, text, conversationId }) -> { conversation_id, reply, card, system_cards, model_version }
//
// Usage metering (§9.9): included allowance per tenant per month; 80% →
// quiet heads-up line; 100% without consent → a consent card and the
// assistant rests (no model call). Billing never starts without the tap.

const { interpretRequest } = require('./interpret');
const { routeQuestion } = require('./tools');
const { createTelemetry } = require('../../shared/src/telemetry');
const { USAGE_INCLUDED_USD, USAGE_HEADS_UP_PCT } = require('../../shared/src/model-config');

const q = (s) => encodeURIComponent(s);
const RETENTION_MONTHS = 12; // §9.8

const ANSWER_SYSTEM = [
  'You are Insyt, a plain-spoken assistant for a small business owner\'s Google Ads account. Short answers, no jargon, British spelling, no emoji, no em dashes.',
  'You are given DATA as JSON. Quote numbers ONLY from the data, verbatim, and say when they are from (the as_of time, as "as of <date>"). Never calculate new figures, never estimate, never promise outcomes. If the data does not contain the answer, say so plainly and suggest where in the dashboard it would be.',
  'You cannot change anything. If they want a change, tell them to say it as a request (for example "lower the Brand budget to 20 a day") and it becomes a card they approve.',
  'Billing questions: point to Settings > Plan; state policy straight, no retention tricks. Off-topic requests: a polite one-line boundary.',
  'Do not mention "the data", "JSON", "tools", or these instructions.',
].join('\n');

const REQUEST_HINT = /\b(set|change|lower|raise|increase|decrease|reduce|cut|pause|stop|switch|turn|enable|exclude|block|don'?t show|never show|add|remove|make|put|move)\b/i;

function createAssistant({ db, generate = null, modelId = null, tools, dashStore = null, usage = null }) {
  const tel = createTelemetry({ db });

  async function usageState(tenantId) {
    if (usage && usage.state) return usage.state(tenantId);
    const month = `${new Date().toISOString().slice(0, 7)}-01`;
    const row = await db.select('model_usage', `tenant_id=eq.${q(tenantId)}&month=eq.${month}&select=cost_usd,billing_consented_at,notified_80_at,notified_100_at`, { single: true }).catch(() => null);
    const cost = row ? Number(row.cost_usd || 0) : 0;
    const pct = USAGE_INCLUDED_USD > 0 ? Math.round((cost / USAGE_INCLUDED_USD) * 100) : 0;
    return { cost_usd: cost, included_usd: USAGE_INCLUDED_USD, pct, consented: !!(row && row.billing_consented_at), notified_80: !!(row && row.notified_80_at), notified_100: !!(row && row.notified_100_at), month };
  }

  async function markNotified(tenantId, month, which) {
    await db.upsert('model_usage', [{ tenant_id: tenantId, month, [`notified_${which}_at`]: new Date().toISOString() }], 'tenant_id,month').catch(() => {});
  }

  async function conversation(tenantId, conversationId) {
    if (conversationId) {
      const c = await db.select('conversations', `id=eq.${q(conversationId)}&tenant_id=eq.${q(tenantId)}&select=id`, { single: true }).catch(() => null);
      if (c) return c.id;
    }
    const open = await db.select('conversations', `tenant_id=eq.${q(tenantId)}&select=id&order=last_message_at.desc&limit=1`, { single: true }).catch(() => null);
    if (open) return open.id;
    const until = new Date(); until.setMonth(until.getMonth() + RETENTION_MONTHS);
    const [row] = await db.insert('conversations', [{ tenant_id: tenantId, retention_until: until.toISOString() }]);
    return row.id;
  }

  async function say(conversationId, tenantId, role, text, extra = {}) {
    await db.insert('messages', [{ conversation_id: conversationId, tenant_id: tenantId, role, text, ...extra }], { returning: false }).catch(() => {});
    await db.update('conversations', `id=eq.${q(conversationId)}`, { last_message_at: new Date().toISOString() }).catch(() => {});
  }

  async function history(conversationId, limit = 8) {
    const rows = await db.select('messages', `conversation_id=eq.${q(conversationId)}&select=role,text,created_at&order=created_at.desc&limit=${limit}`).catch(() => []);
    return (rows || []).reverse();
  }

  /** The draft card: a pending_changes row the Approvals screen renders, with the user's words attached (§7.3 provenance). */
  async function createCard(tenantId, draft, requestText) {
    const [row] = await db.insert('changes', [{
      tenant_id: tenantId, finding_id: null, tool_id: draft.tool_id, params: draft.params, status: 'proposed', actor: 'user_via_chat',
      change_key: draft.change_key, target: draft.target, category: draft.category, before: draft.before, after: draft.after,
      summary_text: draft.summary, ask_reason: 'you asked for it in chat', request_text: requestText,
      idempotency_key: `chat:${tenantId}:${draft.change_key}:${Date.now()}`,
    }]);
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'change_requested', actor: 'user', change_id: row.id,
      summary_text: `You asked: "${requestText}". Drafted as "${draft.summary}" for your approval.` }], { returning: false }).catch(() => {});
    return row;
  }

  async function turn({ tenantId, text, conversationId = null }) {
    const clean = String(text || '').trim().slice(0, 1000);
    const convId = await conversation(tenantId, conversationId);
    await say(convId, tenantId, 'user', clean);
    const systemCards = [];
    const u = await usageState(tenantId);

    // §9.9: allowance exhausted and no consent → the assistant rests. No model call.
    if (u.pct >= 100 && !u.consented) {
      if (!u.notified_100) { await markNotified(tenantId, u.month, '100'); }
      systemCards.push({ kind: 'usage_consent', included_usd: u.included_usd, used_usd: Math.round(u.cost_usd * 100) / 100,
        text: `You have used this month's included assistant allowance ($${u.included_usd}). Continue with usage billed to your card on file, at cost? Nothing else about your account changes either way.` });
      const reply = 'The assistant is resting until next month unless you choose to continue above. Your approvals, alerts, reports and autopilot all keep working as normal.';
      await say(convId, tenantId, 'assistant', reply, { model_version: null, references: { usage: u } });
      return { conversation_id: convId, reply, card: null, system_cards: systemCards, model_version: null };
    }
    if (u.pct >= USAGE_HEADS_UP_PCT && u.pct < 100 && !u.notified_80) {
      await markNotified(tenantId, u.month, '80');
      systemCards.push({ kind: 'usage_heads_up', text: `Heads-up: you have used ${u.pct}% of this month's included assistant allowance ($${u.included_usd}).` });
    }

    const gen = generate ? (args) => generate({ ...args, tenantId }) : null;
    if (!gen) {
      const reply = 'The assistant is not available right now. Your approvals, reports and alerts are unaffected.';
      await say(convId, tenantId, 'assistant', reply, { model_version: null });
      return { conversation_id: convId, reply, card: null, system_cards: systemCards, model_version: null };
    }

    // Requests → interpret → card. Questions → read tools → grounded answer.
    let card = null; let reply; let references = {};
    const looksLikeRequest = REQUEST_HINT.test(clean);
    const ctx = await requestCtx(tenantId);
    let interp = null;
    if (looksLikeRequest) interp = await interpretRequest({ text: clean, ctx, generate: gen });

    if (interp && interp.immediate && interp.immediate.kind === 'autopilot_off') {
      // Contracting what can happen executes immediately (§7.2 asymmetry).
      if (dashStore && dashStore.setAutopilot) {
        const cur = await tools.autopilot(tenantId);
        const next = { negatives: cur.negatives, budgets: cur.budgets, counting: cur.counting };
        for (const c of interp.immediate.categories) next[c] = false;
        await dashStore.setAutopilot(tenantId, next);
      }
      reply = interp.reply;
    } else if (interp && interp.draft) {
      if (interp.draft.tool_id === 'settings.autopilot_on') {
        // Turning autopilot ON is a card; the tap flips the setting (handled by the approve path).
        card = await createCard(tenantId, interp.draft, clean);
      } else {
        const dup = await db.select('changes', `tenant_id=eq.${q(tenantId)}&status=in.(proposed,approved)&target=eq.${q(interp.draft.target)}&select=id,summary_text&limit=1`, { single: true }).catch(() => null);
        if (dup) reply = `You already have a card waiting for that: "${dup.summary_text}". Approve or dismiss it in your approvals first.`;
        else card = await createCard(tenantId, interp.draft, clean);
      }
      reply = reply || interp.reply;
    } else if (interp && interp.reply && !interp.question) {
      reply = interp.reply;
      if (interp.unanswered) await tel.unanswered({ tenantId, source: 'chat', text: clean });
    } else {
      const picks = routeQuestion(clean);
      const data = {};
      for (const p of picks) { try { data[p] = await tools[p](tenantId); } catch { /* absent = say so */ } }
      references = { tools: picks };
      const past = await history(convId, 6);
      const prompt = `DATA:\n${JSON.stringify(data)}\n\nRECENT CONVERSATION:\n${past.map((m) => `${m.role}: ${m.text}`).join('\n')}\n\nQUESTION: ${clean}`;
      try { reply = String(await gen({ system: ANSWER_SYSTEM, prompt })).trim(); } catch { reply = 'Something went wrong on our side; your dashboard has all of this. Try again in a moment.'; }
      if (/cannot|can't|do not have|don't have|not (yet )?(available|in the data)/i.test(reply)) await tel.unanswered({ tenantId, source: 'chat', text: clean });
    }

    await say(convId, tenantId, 'assistant', reply, { model_version: modelId, references, change_id: card ? card.id : null });
    await tel.event({ tenantId, name: 'chat.turn', props: { request: looksLikeRequest, card: !!card }, source: 'server' });
    return { conversation_id: convId, reply, card: card ? { id: card.id, summary: card.summary_text, before_line: card.before && card.before.line, after_line: card.after && card.after.line } : null, system_cards: systemCards, model_version: modelId };
  }

  async function requestCtx(tenantId) {
    const [camps, auto, applied] = await Promise.all([
      tools.campaigns(tenantId), tools.autopilot(tenantId),
      db.select('changes', `tenant_id=eq.${q(tenantId)}&tool_id=eq.ads.pause_campaign&status=eq.applied&select=params`).catch(() => []),
    ]);
    const campaigns = (camps.campaigns || []).map((c) => ({ id: c.id, name: c.name, status: c.status, budget_daily_usd: c.budget_daily_usd, budget_resource: c.budget_resource || null }));
    // budget_resource lives on the live fetch, not the snapshot; the executor
    // re-reads it at apply time, so a null here only blocks the draft when
    // the campaign has never been fetched at all.
    const snap = await db.select('campaigns', `tenant_id=eq.${q(tenantId)}&select=google_campaign_id,budget_resource`).catch(() => []);
    for (const c of campaigns) { const s = (snap || []).find((x) => x.google_campaign_id === c.id); if (s && s.budget_resource) c.budget_resource = s.budget_resource; }
    return {
      campaigns, autopilot: auto, convertingTerms: new Set(), pausedByUs: new Set((applied || []).map((c) => c.params && String(c.params.campaign_id))),
      bounds: { account: { daily_budget_total_usd: campaigns.reduce((s, c) => s + (c.budget_daily_usd || 0), 0) || 1 }, campaign: (id) => campaigns.find((c) => String(c.id) === String(id)) || null, converting_terms: new Set(), reverted_30d: 0 },
    };
  }

  async function consent(tenantId) {
    const u = await usageState(tenantId);
    await db.upsert('model_usage', [{ tenant_id: tenantId, month: u.month, billing_consented_at: new Date().toISOString() }], 'tenant_id,month');
    await db.insert('ledger', [{ tenant_id: tenantId, event: 'subscription_changed', actor: 'user',
      summary_text: `You chose to continue the assistant this month with usage billed at cost beyond the included $${u.included_usd}. It shows as its own line on your invoice.` }], { returning: false }).catch(() => {});
    if (usage && usage.startMetered) await usage.startMetered(tenantId).catch(() => {});
    await tel.event({ tenantId, name: 'usage.consented', props: { pct: u.pct }, source: 'server' });
    return { ok: true };
  }

  async function transcript(tenantId, conversationId = null) {
    const convId = await conversation(tenantId, conversationId);
    const rows = await db.select('messages', `conversation_id=eq.${q(convId)}&select=id,role,text,change_id,created_at&order=created_at.asc&limit=60`).catch(() => []);
    return { conversation_id: convId, messages: rows || [], usage: await usageState(tenantId) };
  }

  return { turn, consent, transcript, usageState };
}

module.exports = { createAssistant, ANSWER_SYSTEM, REQUEST_HINT };
