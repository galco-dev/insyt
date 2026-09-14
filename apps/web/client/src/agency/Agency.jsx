// Agency console - master §13. Portfolio grid, triage queue, report review,
// brand kit, seats. Register inverts here: full technical vocabulary (this
// tree is exempt from the customer jargon lint). Binding rule everywhere:
// no auto-apply, no auto-publish - every action is an explicit seat click.

import React, { useContext, useEffect, useMemo, useState, createContext } from 'react';
import clsx from 'clsx';
import {
  LayoutGrid01 as LayoutGrid, CheckDone01 as ListChecks,
  ArrowRight, FlipBackward as Undo2, Copy01 as Copy, Check, X,
  Building02 as Building2, Plus, PauseCircle as Pause, Play, Trash01 as Trash2, SearchMd as Search,
  Clock, Tool02 as Hammer, Settings01 as SettingsIcon,
} from '@untitledui/icons';
import { api, isDemo, demoHref } from '../lib/api.js';
import { RouterProvider, useRouter, Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote, useCountUp, BrandOrb, Wordmark, ProgressRing, SEV_HEX, ThemeToggle, Segments, CountBadge } from '../lib/ui.jsx';

// Five doors that read like the job: how are things (Portfolio, with a
// Pacing lens) - what needs me (Work: the Triage/Alerts/Review queues, one
// combined count) - make something (Build) - the roster (Accounts) - config
// (Settings: Brand + Seats). Every pre-restructure URL still deep-links
// into its lens or queue.
const NAV = [
  { to: '/app/agency', label: 'Portfolio', icon: LayoutGrid, match: ['/app/agency', '/app/agency/pacing'] },
  { to: '/app/agency/triage', label: 'Work', icon: ListChecks, badge: true, match: ['/app/agency/work', '/app/agency/triage', '/app/agency/alerts', '/app/agency/review'] },
  { to: '/app/agency/build', label: 'Build', icon: Hammer },
  { to: '/app/agency/accounts', label: 'Accounts', icon: Building2 },
  { to: '/app/agency/brand', label: 'Settings', icon: SettingsIcon, match: ['/app/agency/settings', '/app/agency/brand', '/app/agency/seats', '/app/agency/log'] },
];

const SEV = { critical: 'critical', warning: 'warning', info: 'info' };

// Errors have a sentence (agency plan move 3). Every write in the console
// used to swallow its failure; now each card says what happened, and a
// blocked build lists its steps.
function describeError(e) {
  if (!e) return null;
  const data = (e && e.data) || {};
  if (data.code === 'view_only') return { text: 'This seat is view only. Ask an admin to change your role under Seats.' };
  if (data.code === 'brief_only') return { text: 'This account is brief-only: copy the fix brief and apply it by hand.' };
  if (data.code === 'not_owned' || e.status === 404) return { text: 'This item is not on one of your accounts any more. Refresh the queue.' };
  if (e.status === 409) return { text: data.error || 'Blocked for now.', steps: Array.isArray(data.steps) ? data.steps : [] };
  if (e.status === 401) return { text: 'Your sign-in has expired. Sign in again.' };
  if (e.status === 403) return { text: data.error || 'Not allowed for this seat.' };
  if (e.status >= 500) return { text: 'Something went wrong on our side. Nothing changed; try again in a minute.' };
  if (!e.status) return { text: 'Could not reach Insyt. Check your connection and try again.' };
  return { text: data.error || e.message || 'That did not go through.' };
}

function ActionNote({ error, className }) {
  const d = describeError(error);
  if (!d) return null;
  return (
    <div className={clsx('mt-3 rounded bg-warning-tint px-3 py-2 text-small text-strong ring-1 ring-inset ring-warning/25', className)} role="status">
      <div>{d.text}</div>
      {d.steps && d.steps.length > 0 && (
        <ol className="mt-1.5 list-decimal pl-5 text-small text-neutral-900">
          {d.steps.map((st, i) => <li key={i}>{typeof st === 'string' ? st : st.text || st.title || JSON.stringify(st)}</li>)}
        </ol>
      )}
    </div>
  );
}

// "2 minutes ago", "3 days ago": for invite and request lines.
function since(iso) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const ViewOnly = () => (
  <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900" title="This seat can read everything and change nothing">view only</span>
);

function useAgency(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api(path).then(setData).catch((e) => setError(e)); }, [path]);
  return { data, error };
}

// The one "needs you" number: open triage items + unacknowledged alerts +
// reports awaiting review, portfolio-wide. Refetched on every route change
// so it tracks work done anywhere in the console.
function useWorkCounts(path) {
  const [counts, setCounts] = useState({ triage: 0, alerts: 0, review: 0 });
  const [tick, setTick] = useState(0);
  // One counts endpoint (agency plan move 12), refreshed after any write.
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('insyt:work', bump);
    return () => window.removeEventListener('insyt:work', bump);
  }, []);
  useEffect(() => {
    let alive = true;
    api('/api/agency/counts').then((c) => { if (alive && c) setCounts({ triage: c.triage || 0, alerts: c.alerts || 0, review: c.review || 0 }); }).catch(() => {});
    return () => { alive = false; };
  }, [path, tick]);
  return counts;
}

// ---------------------------------------------------------------- scope
// The scope bar is a LENS, not navigation: Account > Campaign narrows every
// screen in place (the stream stays money-sorted). Default is always
// All accounts - the cross-portfolio stream is the product. Scope rides in
// the URL so an account view is bookmarkable for the weekly client call.

const ScopeContext = createContext({ scope: { account: null, campaign: null, mine: false }, setScope: () => {}, accounts: [], campaigns: [], mineNames: null, meName: null, readOnly: false });
const useScope = () => useContext(ScopeContext);

function readScopeFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return { account: p.get('account') || null, campaign: p.get('campaign') || null, mine: p.get('mine') === '1' };
}

function writeScopeToUrl(scope) {
  const p = new URLSearchParams(window.location.search);
  ['account', 'campaign'].forEach((k) => (scope[k] ? p.set(k, scope[k]) : p.delete(k)));
  if (scope.mine) p.set('mine', '1'); else p.delete('mine');
  const qs = p.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

function ScopeBar() {
  const { scope, setScope, accounts, campaigns, meName, mineNames } = useScope();
  const [q, setQ] = useState('');

  const accountName = (id) => (accounts.find((a) => a.id === id) || {}).display_name;
  const accountCampaigns = scope.account ? campaigns.filter((c) => c.account_id === scope.account) : [];

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const acc = accounts
      .filter((a) => a.display_name.toLowerCase().includes(needle))
      .map((a) => ({ kind: 'account', label: a.display_name, sub: 'account', account: a.id, campaign: null }));
    const camp = campaigns
      .filter((c) => c.name.toLowerCase().includes(needle) || c.google_campaign_id === needle)
      .map((c) => ({ kind: 'campaign', label: c.name, sub: `${c.account} · #${c.google_campaign_id}`, account: c.account_id, campaign: c.google_campaign_id }));
    return [...acc, ...camp].slice(0, 8);
  }, [q, accounts, campaigns]);

  const pick = (r) => { setScope({ ...scope, account: r.account, campaign: r.campaign }); setQ(''); };

  return (
    <div className="border-b border-neutral-200 bg-neutral-50">
      <div className="mx-auto flex max-w-xl2 flex-wrap items-center gap-2 px-5 py-2">
        <select
          value={scope.account || ''}
          onChange={(e) => setScope({ ...scope, account: e.target.value || null, campaign: null })}
          className="rounded border border-neutral-400 bg-(--ui-well) px-2.5 py-1.5 text-small outline-none focus:border-(--ui-focus)"
          aria-label="Account scope"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <span className="text-neutral-800" aria-hidden>›</span>
        <select
          value={scope.campaign || ''}
          onChange={(e) => setScope({ ...scope, campaign: e.target.value || null })}
          disabled={!scope.account}
          className="rounded border border-neutral-400 bg-(--ui-well) px-2.5 py-1.5 text-small outline-none focus:border-(--ui-focus) disabled:opacity-50"
          aria-label="Campaign scope"
        >
          <option value="">{scope.account ? 'All campaigns' : 'Pick an account first'}</option>
          {accountCampaigns.map((c) => (
            <option key={c.google_campaign_id} value={c.google_campaign_id}>
              {c.name} · #{c.google_campaign_id}{c.status === 'paused' ? ' (paused)' : ''}
            </option>
          ))}
        </select>
        {(scope.account || scope.campaign || scope.mine) && (
          <button type="button" onClick={() => setScope({ account: null, campaign: null, mine: false })} className="text-small text-neutral-900 underline underline-offset-2">
            Clear
          </button>
        )}
        {meName && mineNames && mineNames.size > 0 && (
          <button
            type="button"
            onClick={() => setScope({ ...scope, mine: !scope.mine })}
            className={clsx('rounded-full border px-3 py-1 font-mono text-tiny',
              scope.mine ? 'border-transparent bg-(--ui-cta-a) text-(--ui-cta-ink)' : 'border-neutral-400 bg-(--ui-well) text-neutral-900')}
            title={`Only accounts managed by ${meName}`}
          >
            My accounts ({mineNames.size})
          </button>
        )}
        <div className="relative ml-auto min-w-[220px] flex-1 sm:max-w-[320px]">
          <div className="flex items-center gap-2 rounded border border-neutral-400 bg-(--ui-well) px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-neutral-800" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find account or campaign - name or ID"
              className="w-full bg-transparent text-small outline-none placeholder:text-neutral-800"
              aria-label="Search accounts and campaigns"
            />
          </div>
          {results.length > 0 && (
            <div className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded border border-neutral-300 bg-card shadow-lg">
              {results.map((r, i) => (
                <button
                  key={`${r.kind}-${r.account}-${r.campaign}-${i}`}
                  type="button"
                  onClick={() => pick(r)}
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-small hover:bg-neutral-50"
                >
                  <span className="truncate font-medium">{r.label}</span>
                  <span className="shrink-0 font-mono text-tiny text-neutral-900">{r.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {(scope.account || scope.campaign) && (
        <div className="mx-auto max-w-xl2 px-5 pb-2 font-mono text-tiny uppercase tracking-wide text-neutral-900">
          Scoped to {accountName(scope.account) || 'account'}
          {scope.campaign && ` › ${(campaigns.find((c) => c.google_campaign_id === scope.campaign) || {}).name || scope.campaign} · #${scope.campaign}`}
          {' - every tab shows only this'}
        </div>
      )}
    </div>
  );
}

// Filter helper shared by scoped screens: account scope matches by display
// name (items carry account names), campaign scope splits campaign-specific
// from account-wide items (tracking findings affect every campaign).
function applyScope(items, scope, accounts, mineNames = null) {
  const name = scope.account ? (accounts.find((a) => a.id === scope.account) || {}).display_name : null;
  let inAccount = name ? items.filter((i) => i.account === name) : items;
  if (scope.mine && mineNames) inAccount = inAccount.filter((i) => mineNames.has(i.account));
  if (!scope.campaign) return { items: inAccount, accountWide: null };
  return {
    items: inAccount.filter((i) => i.campaign_ref === scope.campaign),
    accountWide: inAccount.filter((i) => !i.campaign_ref),
  };
}

// ---------------------------------------------------------------- portfolio

function HealthPill({ score }) {
  const hue = score < 50 ? SEV_HEX.critical : score < 70 ? SEV_HEX.warning : SEV_HEX.success;
  return (
    <ProgressRing value={score} size={38} stroke={3.5} stops={[hue, hue]} className="shrink-0">
      <span className="font-mono text-[11px] font-semibold" style={{ color: hue }}>{score}</span>
    </ProgressRing>
  );
}

function Portfolio() {
  const { data, error } = useAgency('/api/agency/portfolio');
  const { data: pacingData } = useAgency('/api/agency/pacing');
  const { scope, accounts: scopeAccounts, mineNames } = useScope();
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading portfolio" />;
  const scopedName = scope.account ? ((scopeAccounts.find((a) => a.id === scope.account) || {}).display_name || null) : null;
  const accounts = (data.accounts || []).filter((a) => (!scopedName || a.name === scopedName)
    && (!scope.mine || !mineNames || mineNames.has(a.name)));
  const attention = accounts.filter((a) => a.critical > 0 || a.pending_changes > 0).length;
  const paceById = Object.fromEntries(((pacingData && pacingData.accounts) || []).map((r) => [r.account_id, r]));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <MonoLabel>Portfolio</MonoLabel>
          <h1 className="mt-1 text-h3 tracking-tight">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} · {attention} {attention === 1 ? 'needs' : 'need'} attention</h1>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((a, i) => (
          <Card key={a.id} className="rise lift flex flex-col gap-3 p-4" style={{ '--rise-i': Math.min(i, 8) }}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-body font-semibold">{a.name}</div>
                <div className="mt-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">
                  {a.manager || 'Unassigned'} · {a.register}{a.brief_only ? ' · brief-only' : ''}
                </div>
              </div>
              <HealthPill score={a.health} />
            </div>
            <div className="flex items-center gap-4 text-small text-neutral-900">
              <span><strong className={a.critical ? 'text-critical' : 'text-strong'}>{a.critical}</strong> critical</span>
              <span><strong className="text-strong">{a.open_findings}</strong> open</span>
              <span><strong className={a.pending_changes ? 'text-warning' : 'text-strong'}>{a.pending_changes}</strong> pending</span>
              {a.reports_awaiting_review > 0 && <span className="text-info">{a.reports_awaiting_review} report to review</span>}
            </div>
            {paceById[a.id] && (paceById[a.id].performance.status !== 'no_target' || paceById[a.id].pacing.status !== 'on_pace') && (
              <div className="flex flex-wrap items-center gap-1.5">
                {paceById[a.id].pacing.status !== 'on_pace' && (
                  <span className={clsx('rounded-full px-2 py-0.5 font-mono text-tiny', (PACE_STATUS[paceById[a.id].pacing.status] || {}).cls)}>
                    {(PACE_STATUS[paceById[a.id].pacing.status] || {}).label}
                    {paceById[a.id].pacing.deltaPct != null && paceById[a.id].pacing.status !== 'no_budget' ? ` ${paceById[a.id].pacing.deltaPct > 0 ? '+' : ''}${paceById[a.id].pacing.deltaPct}%` : ''}
                  </span>
                )}
                <PerfChip perf={paceById[a.id].performance} />
              </div>
            )}
            {a.connection && a.connection !== 'connected' && (
              <div className="rounded bg-warning-tint px-2.5 py-1.5 text-tiny text-strong ring-1 ring-inset ring-warning/25">
                {a.connection === 'none' ? 'Not connected: approvals wait until the client connects Google.' : 'The client\'s Google connection needs renewing: approvals wait until they reconnect.'}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-neutral-200 pt-2.5 text-tiny text-neutral-900">
              <span>Last report {a.last_report_at ? new Date(a.last_report_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ' - '}</span>
              <Link to={demoHref(`/app/agency/accounts/${a.id}`)} className="inline-flex items-center gap-1 underline underline-offset-2">
                Open account <ArrowRight size={12} aria-hidden />
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- triage

function DiffLine({ label, value }) {
  if (!value) return null;
  return (
    <div className="min-w-0 flex-1">
      <MonoLabel>{label}</MonoLabel>
      <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2.5 font-mono text-tiny leading-relaxed text-neutral-900">{JSON.stringify(value, null, 1)}</pre>
    </div>
  );
}

function TriageItem({ item, index, onDone, selected = false, onSelect = null, forcedState = null }) {
  const [ownState, setState] = useState(null); // null | approved | dismissed | snoozing | snoozed | copied | dismissing | brief
  const [snoozeReason, setSnoozeReason] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [snoozedUntil, setSnoozedUntil] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { readOnly } = useScope();
  const state = forcedState || ownState;

  async function act(kind) {
    setBusy(true); setErr(null);
    try {
      await api(`/api/agency/${kind}/${item.id}`, { method: 'POST', body: kind === 'dismiss' ? { reason: dismissReason.trim() || null } : {} });
      setState(kind === 'approve' ? 'approved' : 'dismissed');
      onDone();
    } catch (e) { setState(null); setErr(e); }
    setBusy(false);
  }
  async function snooze(days) {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/api/agency/snooze/${item.id}`, { method: 'POST', body: { days, reason: snoozeReason.trim() || null } });
      setSnoozedUntil(r.until || new Date(Date.now() + days * 86_400_000).toISOString());
      setState('snoozed');
      onDone();
    } catch (e) { setState(null); setErr(e); }
    setBusy(false);
  }
  const brief = [
    `${item.account} - ${item.title}`,
    `Rule ${item.rule_id} (layer ${item.layer}) · ${item.severity}${item.money_monthly_usd ? ` · ~$${item.money_monthly_usd}/mo` : ''}`,
    '', item.explanation, '',
    `BEFORE: ${JSON.stringify(item.before)}`, `AFTER:  ${JSON.stringify(item.after)}`,
  ].join('\n');
  // Copy fix brief is logged (agency plan move 12); when the clipboard is
  // unavailable the brief is shown, selectable, instead of failing silently.
  async function copyBrief() {
    api(`/api/agency/brief/${item.id}`, { method: 'POST', body: {} }).catch(() => {});
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(brief);
      setState('copied');
      setTimeout(() => setState((s) => (s === 'copied' ? null : s)), 1600);
    } catch { setState('brief'); }
  }

  if (state === 'approved' || state === 'dismissed') {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approved' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} className="text-neutral-900" aria-hidden />}
        {item.account}: {state === 'approved' ? 'approved - the executor applies it with the client\'s own Google connection and verifies' : 'dismissed'} · logged to the audit trail
      </Card>
    );
  }
  if (state === 'snoozed') {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        <Clock size={15} aria-hidden />
        {item.account}: snoozed until {snoozedUntil ? new Date(snoozedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'later'} - it returns to the queue by itself · logged
      </Card>
    );
  }

  return (
    <Card accent={SEV[item.severity] || 'info'} className="rise p-4" style={{ '--rise-i': Math.min(index, 8) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {onSelect && !item.brief_only && !readOnly && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onSelect(item.id)}
              className="size-4 accent-(--ui-cta-a)"
              aria-label={`Select ${item.title} for batch approval`}
            />
          )}
          <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">{item.account}</span>
          {item.campaign_name && (
            <span className="rounded bg-info-tint px-2 py-0.5 font-mono text-tiny text-info" title={item.campaign_ref ? `Campaign #${item.campaign_ref}` : undefined}>
              {item.campaign_name}
            </span>
          )}
          <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">{item.rule_id} · L{item.layer}</span>
        </div>
        {item.money_monthly_usd && <span className="text-small font-semibold">~${item.money_monthly_usd}/mo</span>}
      </div>
      <h3 className="mt-2 text-h5">{item.title}</h3>
      <p className="mt-1 text-small text-neutral-900">{item.explanation}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <DiffLine label="Before" value={item.before} />
        <DiffLine label="After" value={item.after} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
        {readOnly && <ViewOnly />}
        {!readOnly && item.build_template ? (
          <Link
            to={demoHref(`/app/agency/build?template=${item.build_template}&for=${encodeURIComponent(item.account)}`)}
            className="inline-flex items-center gap-1.5 rounded bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) px-4 py-2 text-small font-medium text-(--ui-cta-ink) ring-1 ring-inset ring-(--ui-cta-edge) shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_var(--ui-cta-hi)]"
          >
            <Hammer size={13} aria-hidden /> Build it
          </Link>
        ) : !readOnly && !item.brief_only && (
          <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Apply</Button>
        )}
        <Button variant="secondary" onClick={copyBrief} className="!px-4 !py-2">
          <Copy size={13} aria-hidden /> {state === 'copied' ? 'Copied' : 'Copy fix brief'}
        </Button>
        {!readOnly && state !== 'dismissing' && <Button variant="ghost" onClick={() => setState('dismissing')} disabled={busy} className="!py-2">Dismiss</Button>}
        {!readOnly && state !== 'snoozing' && (
          <Button variant="ghost" onClick={() => setState('snoozing')} disabled={busy} className="!py-2">
            <Clock size={13} aria-hidden /> Snooze
          </Button>
        )}
        {item.brief_only && <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">brief-only account - Apply disabled</span>}
      </div>
      <ActionNote error={err} />
      {state === 'brief' && (
        <div className="mt-3 rounded bg-neutral-50 p-3">
          <div className="mb-1 text-tiny text-neutral-900">Could not reach the clipboard. Select and copy the brief here.</div>
          <textarea readOnly value={brief} rows={6} onFocus={(e) => e.target.select()} className="w-full rounded border border-neutral-400 bg-(--ui-well) p-2 font-mono text-tiny" aria-label="Fix brief" />
          <button type="button" onClick={() => setState(null)} className="mt-1 text-small underline underline-offset-2">Close</button>
        </div>
      )}
      {state === 'dismissing' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded bg-neutral-50 p-3">
          <input
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && act('dismiss')}
            placeholder="Why? Optional; the client reads it in their history"
            className="min-w-[220px] flex-1 rounded border border-neutral-400 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)"
            aria-label="Dismiss reason"
          />
          <Button variant="secondary" onClick={() => act('dismiss')} disabled={busy} className="!px-3 !py-2">Dismiss</Button>
          <Button variant="ghost" onClick={() => { setState(null); setDismissReason(''); }} className="!py-2">Cancel</Button>
        </div>
      )}
      {state === 'snoozing' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded bg-neutral-50 p-3">
          <input
            value={snoozeReason}
            onChange={(e) => setSnoozeReason(e.target.value)}
            placeholder="Reason (lands in the audit trail)"
            className="min-w-[220px] flex-1 rounded border border-neutral-400 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)"
            aria-label="Snooze reason"
          />
          <Button variant="secondary" onClick={() => snooze(7)} disabled={busy} className="!px-3 !py-2">7 days</Button>
          <Button variant="secondary" onClick={() => snooze(30)} disabled={busy} className="!px-3 !py-2">30 days</Button>
          <Button variant="ghost" onClick={() => { setState(null); setSnoozeReason(''); }} className="!py-2">Cancel</Button>
        </div>
      )}
    </Card>
  );
}

function Triage() {
  const { data, error } = useAgency('/api/agency/triage');
  const [, force] = useState(0);
  const [sel, setSel] = useState({});
  const [batched, setBatched] = useState(() => new Set());
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [snoozedData, setSnoozedData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [batchErr, setBatchErr] = useState(null);
  const [batchNote, setBatchNote] = useState(null);
  const { scope, accounts, mineNames } = useScope();
  // Snoozed items come from the server on request (agency plan move 12).
  useEffect(() => { if (showSnoozed && !snoozedData) api('/api/agency/triage?snoozed=1').then((d) => setSnoozedData(d.queue || [])).catch(() => setSnoozedData([])); }, [showSnoozed, snoozedData]);
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading triage queue" />;

  const scoped = applyScope(data.queue || [], scope, accounts, mineNames);
  const snoozed = applyScope(snoozedData || [], scope, accounts, mineNames);
  const snoozedAll = [...snoozed.items, ...(snoozed.accountWide || [])];
  const { items: queue, accountWide } = scoped;

  const toggle = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const selIds = Object.keys(sel).filter((id) => sel[id] && !batched.has(id));
  const allItems = [...queue, ...(accountWide || [])];
  const selMoney = selIds.reduce((n, id) => n + ((allItems.find((i) => i.id === id) || {}).money_monthly_usd || 0), 0);

  async function approveSelected() {
    setBusy(true); setBatchErr(null); setBatchNote(null);
    try {
      const r = await api('/api/agency/approve-batch', { method: 'POST', body: { ids: selIds } });
      const skipped = new Set((r.skipped || []).map((x) => x.id));
      setBatched((b) => new Set([...b, ...selIds.filter((id) => !skipped.has(id))]));
      setSel({});
      if (skipped.size) setBatchNote(`${r.approved} approved. ${skipped.size} skipped: ${(r.skipped || []).some((x) => x.reason === 'brief_only') ? 'brief-only accounts take the brief, not an apply' : 'no longer on one of your accounts'}.`);
    } catch (e) { setBatchErr(e); }
    setBusy(false);
  }

  const itemProps = (item, i) => ({
    item, index: i, onDone: () => force((n) => n + 1),
    selected: !!sel[item.id], onSelect: toggle,
    forcedState: batched.has(item.id) ? 'approved' : null,
  });

  const scopedTitle = scope.campaign
    ? `${queue.length} for this campaign, biggest money first`
    : `${queue.length} proposed changes, biggest money first`;
  return (
    <div>
      <MonoLabel>Triage</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{scopedTitle}</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        Every change ships both ways: Apply (the executor applies it with the client&apos;s own Google connection and verifies it) or Copy fix brief for manual execution. Nothing is ever auto-applied. Tick several and approve them in one go - each still lands individually in the per-seat audit log. Snooze parks an item with a reason; it comes back by itself.
      </p>
      {selIds.length > 0 && (
        <div className="sticky top-[105px] z-20 mt-4 flex flex-wrap items-center gap-3 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2.5 shadow-sm">
          <span className="text-small font-semibold">{selIds.length} selected{selMoney ? ` · ~$${selMoney}/mo total` : ''}</span>
          <Button onClick={approveSelected} disabled={busy} className="!px-4 !py-2">Approve {selIds.length} selected</Button>
          <button type="button" onClick={() => setSel({})} className="text-small text-neutral-900 underline underline-offset-2">Clear</button>
        </div>
      )}
      <ActionNote error={batchErr} />
      {batchNote && <p className="mt-3 text-small text-neutral-900" role="status">{batchNote}</p>}
      {queue.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title={scope.account ? 'Nothing in this scope' : 'Queue is clear'}
            body={scope.account ? 'No proposed changes match the current scope - clear it to see the full stream.' : 'New findings from the weekly runs land here across every account.'}
          />
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {queue.map((item, i) => <TriageItem key={item.id} {...itemProps(item, i)} />)}
        </div>
      )}
      {accountWide && accountWide.length > 0 && (
        <div className="mt-8">
          <MonoLabel>Account-wide - affects this campaign too</MonoLabel>
          <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
            Tracking and account-level issues aren&apos;t tied to one campaign, but they distort this campaign&apos;s data all the same.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {accountWide.map((item, i) => <TriageItem key={item.id} {...itemProps(item, i)} />)}
          </div>
        </div>
      )}
      {(
        <div className="mt-8 border-t border-neutral-200 pt-4">
          <button type="button" onClick={() => setShowSnoozed((s) => !s)} className="flex items-center gap-2 font-mono text-tiny uppercase tracking-wide text-neutral-900">
            <Clock size={13} aria-hidden /> Snoozed{snoozedData ? ` (${snoozedAll.length})` : ''} {showSnoozed ? ' -  hide' : ' -  show'}
          </button>
          {showSnoozed && snoozedData && snoozedAll.length === 0 && <p className="mt-2 text-small text-neutral-900">Nothing snoozed.</p>}
          {showSnoozed && (
            <div className="mt-3 flex flex-col gap-2">
              {snoozedAll.map((item) => (
                <Card key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 p-3.5 text-small text-neutral-900">
                  <span><strong>{item.account}</strong> · {item.title}</span>
                  <span className="font-mono text-tiny">
                    returns {new Date(item.snoozed_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {item.snooze_reason ? ` - “${item.snooze_reason}”` : ''}
                  </span>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pacing
// The daily agency ritual - "is anything going to blow its budget?" - as one
// sorted list. Targets here are the agency's own operating targets for the
// work (budget/CPA/ROAS); what they charge the client never enters the
// platform (binding).

const PACE_STATUS = {
  over: { label: 'over pace', cls: 'bg-critical-tint text-critical', dot: 'bg-critical', halo: 'color-mix(in srgb, var(--ui-critical) 22%, transparent)' },
  at_risk: { label: 'accelerating', cls: 'bg-warning-tint text-warning', dot: 'bg-warning', halo: 'color-mix(in srgb, var(--ui-warning) 22%, transparent)' },
  under: { label: 'under pace', cls: 'bg-info-tint text-info', dot: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  no_budget: { label: 'no budget set', cls: 'bg-neutral-100 text-neutral-900', dot: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
  on_pace: { label: 'on pace', cls: 'bg-success-tint text-success', dot: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
};

function StatusChip({ st, className }) {
  if (!st || !st.label) return null;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-tiny', st.cls, className)}>
      {st.dot && (
        <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', st.dot)} style={{ boxShadow: `0 0 0 2.5px ${st.halo}` }} />
      )}
      {st.label}
    </span>
  );
}

function PerfChip({ perf }) {
  if (!perf || perf.status === 'no_target') return null;
  const hit = perf.status === 'hitting';
  const label = perf.cpaTargetUsd != null
    ? `CPA $${perf.cpa ?? ' - '} vs $${perf.cpaTargetUsd} target`
    : `ROAS ${perf.roas ?? ' - '} vs ${perf.roasTarget} target`;
  return (
    <span className={clsx('rounded-full px-2 py-0.5 font-mono text-tiny', hit ? 'bg-success-tint text-success' : 'bg-critical-tint text-critical')}>
      {label}
    </span>
  );
}

function TargetEditor({ row, onClose }) {
  const [form, setForm] = useState({
    monthly_budget_usd: row.targets.monthly_budget_usd || '',
    cpa_target_usd: row.targets.cpa_target_usd || '',
    roas_target: row.targets.roas_target || '',
  });
  const [busy, setBusy] = useState(false);
  const num = (v) => (v === '' || v == null ? null : Number(v));
  async function save() {
    setBusy(true);
    try {
      await api(`/api/agency/targets/${row.account_id}`, {
        method: 'POST',
        body: { monthly_budget_usd: num(form.monthly_budget_usd), cpa_target_usd: num(form.cpa_target_usd), roas_target: num(form.roas_target) },
      });
      onClose(true);
    } catch { onClose(false); }
    setBusy(false);
  }
  const field = (label, key, placeholder) => (
    <label className="flex flex-col gap-1">
      <MonoLabel>{label}</MonoLabel>
      <input
        type="number" min="0" step="0.01"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        className="w-32 rounded border border-neutral-400 bg-(--ui-well) px-2.5 py-2 text-small outline-none focus:border-(--ui-focus)"
      />
    </label>
  );
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded bg-neutral-50 p-3">
      {field('Monthly budget $', 'monthly_budget_usd', 'e.g. 3000')}
      {field('CPA target $', 'cpa_target_usd', 'optional')}
      {field('ROAS target', 'roas_target', 'optional')}
      <Button onClick={save} disabled={busy} className="!px-4 !py-2">Save targets</Button>
      <Button variant="ghost" onClick={() => onClose(false)} className="!py-2">Cancel</Button>
    </div>
  );
}

function PacingRow({ row, index }) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const p = row.pacing;
  const st = PACE_STATUS[p.status] || PACE_STATUS.on_pace;
  const spentPct = p.budget ? Math.min(100, Math.round((p.mtd / p.budget) * 100)) : 0;
  const expectedPct = p.budget ? Math.min(100, Math.round((p.dayOfMonth / p.daysInMonth) * 100)) : 0;
  const barTone = p.status === 'over' ? 'bg-critical' : p.status === 'at_risk' ? 'bg-warning' : p.status === 'under' ? 'bg-info' : 'bg-success';
  return (
    <Card accent={p.status === 'over' ? 'critical' : p.status === 'at_risk' ? 'warning' : undefined} className="rise p-4" style={{ '--rise-i': Math.min(index, 8) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-body font-semibold">{row.account}</span>
          <StatusChip st={st} />
          <PerfChip perf={row.performance} />
          {saved && <span className="font-mono text-tiny text-success">targets saved</span>}
        </div>
        <button type="button" onClick={() => { setEditing((e) => !e); setSaved(false); }} className="text-small text-neutral-900 underline underline-offset-2">
          {editing ? 'Close' : 'Edit targets'}
        </button>
      </div>
      {p.budget ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-small text-neutral-900">
            <span><strong className="text-strong">${p.mtd.toLocaleString()}</strong> of ${p.budget.toLocaleString()} spent</span>
            <span>day {p.dayOfMonth} of {p.daysInMonth} - even pace would be ${Math.round(p.expectedToDate).toLocaleString()}</span>
            <span>projected <strong className={p.status === 'over' || p.status === 'at_risk' ? 'text-critical' : 'text-strong'}>${Math.round(p.projected).toLocaleString()}</strong> ({p.deltaPct > 0 ? '+' : ''}{p.deltaPct}%)</span>
          </div>
          <div className="relative mt-2 h-2 rounded-full bg-neutral-100">
            <div className={clsx('h-2 rounded-full', barTone)} style={{ width: `${spentPct}%` }} />
            <div className="absolute top-[-3px] h-[14px] w-px bg-neutral-900" style={{ left: `${expectedPct}%` }} title="Where even pacing would be today" />
          </div>
        </>
      ) : (
        <p className="mt-3 text-small text-neutral-900">
          ${p.mtd.toLocaleString()} spent this month with no budget target set - set one so pacing can watch this account.
        </p>
      )}
      {editing && <TargetEditor row={row} onClose={(ok) => { setEditing(false); if (ok) setSaved(true); }} />}
    </Card>
  );
}

function Pacing() {
  const { data, error } = useAgency('/api/agency/pacing');
  const { scope, mineNames } = useScope();
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading pacing" />;
  const rows = (data.accounts || []).filter((r) => (!scope.account || r.account_id === scope.account)
    && (!scope.mine || !mineNames || mineNames.has(r.account)));
  const problems = rows.filter((r) => ['over', 'at_risk', 'under', 'no_budget'].includes(r.pacing.status)).length;
  const day = rows[0] ? `day ${rows[0].pacing.dayOfMonth} of ${rows[0].pacing.daysInMonth}` : '';
  return (
    <div>
      <MonoLabel>Budget pacing</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{problems === 0 ? 'Everything on pace' : `${problems} ${problems === 1 ? 'account needs' : 'accounts need'} a look`}{day ? ` · ${day}` : ''}</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        Month-to-date spend against each account&apos;s budget, projected forward at the current run rate. The tick on each bar is where even pacing would be today. Problems sort first. Budgets and CPA/ROAS targets here are your operating targets - what you charge your clients never enters this platform.
      </p>
      <div className="mt-5 flex flex-col gap-3">
        {rows.map((r, i) => <PacingRow key={r.account_id} row={r} index={i} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- alerts

function AlertRow({ a, index }) {
  const [acked, setAcked] = useState(!!a.acked_at);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { readOnly } = useScope();
  async function ack() {
    setBusy(true); setErr(null);
    try { await api(`/api/agency/alerts/${a.id}/ack`, { method: 'POST', body: {} }); setAcked(true); } catch (e) { setErr(e); }
    setBusy(false);
  }
  return (
    <Card accent={acked ? undefined : (SEV[a.severity] || 'info')} className={clsx('rise p-4', acked && 'opacity-70')} style={{ '--rise-i': Math.min(index, 8) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">{a.account}</span>
          {a.campaign_ref && <span className="rounded bg-info-tint px-2 py-0.5 font-mono text-tiny text-info">#{a.campaign_ref}</span>}
          <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">{a.kind.replace(/_/g, ' ')}</span>
        </div>
        <span className="font-mono text-tiny text-neutral-900">
          {new Date(a.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <h3 className="mt-2 text-h5">{a.title}</h3>
      {a.detail && a.detail.note && <p className="mt-1 text-small text-neutral-900">{a.detail.note}</p>}
      <div className="mt-3 flex items-center gap-2 border-t border-neutral-200 pt-3">
        {acked ? (
          <span className="flex items-center gap-1.5 text-small text-neutral-900">
            <Check size={14} className="text-success" aria-hidden />
            Acknowledged{a.acked_seat ? ` by ${a.acked_seat.name}` : ''}
          </span>
        ) : readOnly ? <ViewOnly /> : (
          <Button variant="secondary" onClick={ack} disabled={busy} className="!px-4 !py-2">Acknowledge</Button>
        )}
      </div>
      <ActionNote error={err} />
    </Card>
  );
}

function Alerts() {
  const { data, error } = useAgency('/api/agency/alerts');
  const { scope, accounts, mineNames } = useScope();
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading alerts" />;
  const scoped = applyScope(data.alerts || [], scope, accounts, mineNames);
  const rows = scope.campaign ? [...scoped.items, ...(scoped.accountWide || [])] : scoped.items;
  const open = rows.filter((a) => !a.acked_at).length;
  return (
    <div>
      <MonoLabel>Alerts</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{open === 0 ? 'Nothing waiting on you' : `${open} unacknowledged`}</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        Breakage and fast movers that can&apos;t wait for the weekly run: tags going dark, spend spikes, disapprovals, conversion flatlines. Each alert emails the account&apos;s assigned seat (the client too, when the account copies them), and every seat gets one morning digest of what is still unacknowledged. Acknowledging here takes it off tomorrow&apos;s digest. Alerts only ever notify; fixes still go through triage.
      </p>
      {rows.length === 0 ? (
        <div className="mt-5"><EmptyState title="All quiet" body="Alerts land here the moment monitoring spots them." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {rows.map((a, i) => <AlertRow key={a.id} a={a} index={i} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- build
// Campaign creation = the biggest possible "change" (before: nothing →
// after: this spec), through the same explicit-approval pipeline as every
// fix. Invariants: created PAUSED, enabling is a second explicit click,
// every step lands in the per-seat audit log. The builder refuses to draft
// onto broken measurement.

function briefFromSpec(spec) {
  const lines = [
    `CAMPAIGN BUILD BRIEF - ${spec.name}`,
    `Channel: ${spec.channel} · Budget: $${spec.budget_daily_usd}/day · Bidding: ${spec.bidding}${spec.conversion_goal ? ` → ${spec.conversion_goal}` : ''}`,
    `Settings: geo ${spec.settings.geo} · networks ${(spec.settings.networks || []).join('+')} · CREATE PAUSED`,
  ];
  for (const ag of spec.ad_groups || []) {
    lines.push('', `AD GROUP: ${ag.name}${ag.audience ? ` · audience ${ag.audience}` : ''}`);
    if ((ag.keywords || []).length) lines.push(`  Keywords: ${ag.keywords.map((k) => k.text).join(', ')}`);
    if ((ag.negatives || []).length) lines.push(`  Negatives: ${ag.negatives.join(', ')}`);
    lines.push(`  RSA headlines (${ag.rsa.headlines.length}): ${ag.rsa.headlines.join(' | ')}`);
    lines.push(`  RSA descriptions (${ag.rsa.descriptions.length}): ${ag.rsa.descriptions.join(' | ')}`);
  }
  if ((spec.tracking_checks || []).length) lines.push('', `Pre-flight: ${spec.tracking_checks.join(' · ')}`);
  return lines.join('\n');
}

const DRAFT_STATUS = {
  draft: { label: 'draft', cls: 'bg-neutral-100 text-neutral-900', dot: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
  staged: { label: 'staged - blocked until the account is ready', cls: 'bg-warning-tint text-warning', dot: 'bg-warning', halo: 'color-mix(in srgb, var(--ui-warning) 22%, transparent)' },
  created_paused: { label: 'created - paused', cls: 'bg-info-tint text-info', dot: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  enabled: { label: 'enabled', cls: 'bg-success-tint text-success', dot: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
};

function DraftCard({ d, index }) {
  const [status, setStatus] = useState(d.status);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [headlines, setHeadlines] = useState(() => ((d.spec && d.spec.ad_groups) || []).map((g) => ((g.rsa && g.rsa.headlines) || []).join('\n')));
  const [spec, setSpec] = useState(d.spec || {});
  const { readOnly } = useScope();
  // A placeholder campaign (no Google credentials yet) exists nowhere in Google Ads; it cannot be enabled.
  const provisional = String(d.google_campaign_id || '').startsWith('draft-') || String(d.google_campaign_id || '').startsWith('demo-provisional');
  const gates = spec.gates || null;

  async function act(action) {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/api/agency/drafts/${d.id}/${action}`, { method: 'POST', body: {} });
      setStatus(r.status || (action === 'approve' ? 'created_paused' : action === 'enable' ? 'enabled' : 'dismissed'));
      if (r.status === 'staged' && r.steps) setSpec((s) => ({ ...s, gates: { ok: false, blockers: r.blockers || [], steps: r.steps } }));
    } catch (e) { setErr(e); }
    setBusy(false);
  }
  // A one-field headline editor (agency plan move 12) on the existing edit route.
  async function saveHeadlines() {
    setBusy(true); setErr(null);
    try {
      const groups = (spec.ad_groups || []).map((g, i) => ({ ...g, rsa: { ...(g.rsa || {}), headlines: headlines[i].split('\n').map((h) => h.trim()).filter(Boolean).slice(0, 15) } }));
      await api(`/api/agency/drafts/${d.id}/edit`, { method: 'POST', body: { ad_groups: groups } });
      setSpec((s) => ({ ...s, ad_groups: groups }));
      setEditing(false);
    } catch (e) { setErr(e); }
    setBusy(false);
  }
  function copyBrief() {
    if (navigator.clipboard) navigator.clipboard.writeText(briefFromSpec(spec)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (status === 'dismissed') {
    return <Card className="p-4 text-small text-neutral-900">{d.account}: draft dismissed · logged</Card>;
  }
  const st = DRAFT_STATUS[status] || DRAFT_STATUS.draft;
  const groups = spec.ad_groups || [];
  const blocked = status === 'staged' || (gates && gates.ok === false && status === 'draft');
  return (
    <Card accent={status === 'created_paused' ? 'info' : undefined} className="rise p-4" style={{ '--rise-i': Math.min(index, 8) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">{d.account}</span>
          <span className="text-body font-semibold">{spec.name}</span>
          <StatusChip st={st} />
        </div>
        <span className="font-mono text-tiny text-neutral-900">${spec.budget_daily_usd}/day · {spec.bidding}</span>
      </div>
      <div className="mt-2 text-small text-neutral-900">
        {spec.channel} · {groups.length} ad group{groups.length === 1 ? '' : 's'} · {groups.reduce((n, g) => n + ((g.keywords || []).length), 0)} keywords · goal {spec.conversion_goal || ' - '}
        {' · '}
        <button type="button" onClick={() => setOpen((o) => !o)} className="underline underline-offset-2">{open ? 'hide spec' : 'view full spec'}</button>
      </div>
      {open && (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-3 font-mono text-tiny leading-relaxed text-neutral-900">{briefFromSpec(spec)}</pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-3">
        {readOnly && <ViewOnly />}
        {!readOnly && (status === 'draft' || status === 'staged') && (
          <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">{status === 'staged' ? 'Try again' : 'Create in Google Ads - paused'}</Button>
        )}
        {!readOnly && status === 'draft' && !editing && (
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy} className="!px-4 !py-2">Edit headlines</Button>
        )}
        {!readOnly && status === 'created_paused' && !provisional && (
          <Button onClick={() => act('enable')} disabled={busy} className="!px-4 !py-2"><Play size={13} aria-hidden /> Enable - starts spending</Button>
        )}
        {status === 'created_paused' && provisional && <span className="font-mono text-tiny uppercase tracking-wide text-warning">placeholder only - nothing exists in Google Ads yet, so it cannot be enabled</span>}
        <Button variant="secondary" onClick={copyBrief} className="!px-4 !py-2">
          <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy build brief'}
        </Button>
        {!readOnly && status !== 'enabled' && (
          <Button variant="ghost" onClick={() => act('dismiss')} disabled={busy} className="!py-2">Dismiss</Button>
        )}
        {status === 'created_paused' && !provisional && <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">paused - spends nothing until enabled</span>}
        {status === 'enabled' && <span className="font-mono text-tiny uppercase tracking-wide text-success">live · pause it from Google Ads or ask us</span>}
      </div>
      {blocked && gates && (
        <div className="mt-3 rounded bg-warning-tint px-3 py-2 text-small text-strong ring-1 ring-inset ring-warning/25">
          <div>Blocked until the account is ready{gates.blockers && gates.blockers.length ? `: ${gates.blockers.join('; ')}` : ''}.</div>
          {gates.steps && gates.steps.length > 0 && <ol className="mt-1.5 list-decimal pl-5 text-neutral-900">{gates.steps.map((s, i) => <li key={i}>{typeof s === 'string' ? s : s.text || s.title || JSON.stringify(s)}</li>)}</ol>}
        </div>
      )}
      {editing && (
        <div className="mt-3 flex flex-col gap-2 rounded bg-neutral-50 p-3">
          {groups.map((g, i) => (
            <label key={g.name || i} className="flex flex-col gap-1 text-small">
              <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">{g.name} · one headline per line, 30 characters each</span>
              <textarea value={headlines[i] || ''} onChange={(e) => setHeadlines((hs) => hs.map((h, j) => (j === i ? e.target.value : h)))} rows={5} className="rounded border border-neutral-400 bg-(--ui-well) p-2 font-mono text-tiny" />
            </label>
          ))}
          <div className="flex gap-2">
            <Button onClick={saveHeadlines} disabled={busy} className="!px-3 !py-2">Save headlines</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} className="!py-2">Cancel</Button>
          </div>
        </div>
      )}
      <ActionNote error={err} />
    </Card>
  );
}

function Build() {
  const { data, error } = useAgency('/api/agency/drafts');
  const { scope, accounts } = useScope();
  const params = new URLSearchParams(window.location.search);
  const forName = params.get('for');
  const prefillAccount = forName
    ? ((accounts.find((a) => a.display_name === forName) || {}).id || '')
    : (scope.account || '');
  const [form, setForm] = useState({
    account_id: prefillAccount,
    template: params.get('template') || 'generic',
    services: '',
    location: '',
    budget_daily_usd: '',
  });
  const [created, setCreated] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (prefillAccount && !form.account_id) setForm((f) => ({ ...f, account_id: prefillAccount })); }, [prefillAccount]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading drafts" />;

  async function create() {
    if (!form.account_id) return;
    setBusy(true); setErr(null);
    try {
      const r = await api('/api/agency/drafts', {
        method: 'POST',
        body: {
          account_id: form.account_id,
          template: form.template,
          inputs: {
            services: form.services.split(',').map((s) => s.trim()).filter(Boolean),
            location: form.location.trim() || null,
            budget_daily_usd: form.budget_daily_usd ? Number(form.budget_daily_usd) : undefined,
          },
        },
      });
      if (r.draft) setCreated((xs) => [r.draft, ...xs]);
    } catch (e) { setErr(e); }
    setBusy(false);
  }

  const rows = [...created, ...(data.drafts || [])].filter((d) => !scope.account || d.account_id === scope.account);
  const sel = 'rounded border border-neutral-400 bg-(--ui-well) px-2.5 py-2 text-small outline-none focus:border-(--ui-focus)';

  return (
    <div>
      <MonoLabel>Campaign builder</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">Drafted from the account&apos;s own data. Born paused.</h1>
      <p className="mt-1 max-w-[74ch] text-small text-neutral-900">
        A build is the biggest change we can propose, so it ships through the same pipeline as every fix: draft → you approve → created in Google Ads <strong>paused</strong> → you enable, as a second explicit click. The builder refuses to draft onto broken measurement - tracking findings clear first. Every step logs to the per-seat audit trail. Brief-only workflow? Copy the build brief instead.
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded border border-neutral-300 bg-card p-4">
        <label className="flex flex-col gap-1">
          <MonoLabel>Account</MonoLabel>
          <select value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })} className={sel} aria-label="Account for the new campaign">
            <option value="">Pick an account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <MonoLabel>Template</MonoLabel>
          <select value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} className={sel} aria-label="Campaign template">
            <option value="brand">Brand - own-name searches</option>
            <option value="generic">Generic - service searches</option>
            <option value="remarketing">Remarketing - past visitors</option>
          </select>
        </label>
        {form.template === 'generic' && (
          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <MonoLabel>Services (comma-separated)</MonoLabel>
            <input value={form.services} onChange={(e) => setForm({ ...form, services: e.target.value })} placeholder="Gel nails, Lash lifts" className={sel} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <MonoLabel>Location</MonoLabel>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Dubai" className={clsx(sel, 'w-28')} />
        </label>
        <label className="flex flex-col gap-1">
          <MonoLabel>Budget $/day</MonoLabel>
          <input type="number" min="1" value={form.budget_daily_usd} onChange={(e) => setForm({ ...form, budget_daily_usd: e.target.value })} placeholder="10" className={clsx(sel, 'w-24')} />
        </label>
        <Button onClick={create} disabled={busy || !form.account_id} className="!px-4 !py-2.5">
          <Hammer size={14} aria-hidden /> Draft it
        </Button>
      </div>
      <ActionNote error={err} />

      {rows.length === 0 ? (
        <div className="mt-5"><EmptyState title="No drafts yet" body="Draft one above, or hit Build on any coverage-gap finding in Triage - it lands here pre-filled." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {rows.map((d, i) => <DraftCard key={d.id} d={d} index={i} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- review queue

function ReviewItem({ r }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { readOnly } = useScope();
  async function act(kind) {
    setBusy(true); setErr(null);
    try {
      await api(`/api/agency/report/${r.id}/${kind}`, { method: 'POST', body: kind === 'reject' ? { reason: 'needs edits' } : {} });
      setState(kind);
    } catch (e) { setErr(e); }
    setBusy(false);
  }
  if (state) {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approve' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} aria-hidden />}
        {r.account}: report {state === 'approve' ? 'approved and on its way to the client' : 'sent back; the client will not see it'} · logged
      </Card>
    );
  }
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-body font-semibold">{r.account}</div>
        <div className="mt-0.5 text-small text-neutral-900">
          {r.type === 'deep' ? 'Deep audit' : 'Weekly report'} · rendered {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · web view
        </div>
        <ActionNote error={err} />
      </div>
      <div className="flex shrink-0 gap-2">
        <a href={r.url || demoHref('/app/report')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2 text-small font-medium">Preview</a>
        {readOnly ? <ViewOnly /> : (
          <>
            <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Approve</Button>
            <Button variant="ghost" onClick={() => act('reject')} disabled={busy} className="!py-2">Send back</Button>
          </>
        )}
      </div>
    </Card>
  );
}

function Review() {
  const { data, error } = useAgency('/api/agency/review');
  const { scope, accounts, mineNames } = useScope();
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading review queue" />;
  // Reports are account-level renders - campaign scope narrows to the account.
  const { items: queue } = applyScope(data.queue || [], { account: scope.account, campaign: null, mine: scope.mine }, accounts, mineNames);
  return (
    <div>
      <MonoLabel>Report review</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{queue.length} awaiting sign-off</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">
        Reports for accounts with review on wait here. Nothing reaches the client until a seat approves it: the email stays held and the client&apos;s app says their agency is reviewing. Send back keeps it hidden; the next weekly check produces a fresh one. Review is on by default and per account, on the account page.
      </p>
      {queue.length === 0 ? (
        <div className="mt-5"><EmptyState title="Nothing waiting" body="Every weekly report for an account with review on lands here before the client sees it." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">{queue.map((r) => <ReviewItem key={r.id} r={r} />)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- accounts + billing

const ACC_STATUS = {
  active: { label: 'active', cls: 'bg-success-tint text-success', dot: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
  pending: { label: 'awaiting Google connection - not billed', cls: 'bg-info-tint text-info', dot: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  removed: { label: 'removed', cls: 'bg-neutral-100 text-neutral-900', dot: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
  paused: { label: 'paused - not checked, not billed', cls: 'bg-neutral-100 text-neutral-900', dot: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
};

function AccountRow({ a, onAction }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [status, setStatus] = useState(a.status);
  const [err, setErr] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [email, setEmail] = useState(a.request_email || '');
  const [requested, setRequested] = useState(a.request_sent_at ? { at: a.request_sent_at, to: a.request_email } : null);
  const { readOnly } = useScope();
  async function act(kind) {
    setBusy(true); setErr(null);
    try {
      await api(`/api/agency/accounts/${a.id}/${kind}`, { method: 'POST', body: {} });
      if (kind === 'remove') setGone(true);
      else setStatus(kind === 'pause' ? 'paused' : 'active');
      onAction();
    } catch (e) { setErr(e); }
    setBusy(false); setConfirming(false);
  }
  // Request access later, or again (agency plan move 5).
  async function request() {
    if (!email.includes('@')) return;
    setBusy(true); setErr(null);
    try {
      const r = await api(`/api/agency/accounts/${a.id}/request`, { method: 'POST', body: { email: email.trim() } });
      setRequested({ at: r.at || new Date().toISOString(), to: email.trim().toLowerCase() });
      setAsking(false);
    } catch (e) { setErr(e); }
    setBusy(false);
  }
  if (gone) {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        <Check size={15} className="text-success" aria-hidden />
        {a.display_name} removed. Checks and emails have stopped, the client has been told, and billing stops at the end of this cycle. Show removed accounts to read its history.
      </Card>
    );
  }
  const st = ACC_STATUS[status] || ACC_STATUS.active;
  const field = 'rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={demoHref(`/app/agency/accounts/${a.id}`)} className="text-body font-semibold underline-offset-2 hover:underline">{a.display_name}</Link>
          <StatusChip st={st} />
        </div>
        <div className="mt-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">
          {a.seat ? a.seat.name : 'Unassigned'} · {a.report_register}{a.brief_only ? ' · brief-only' : ''} · added {new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          {status === 'removed' && a.removed_at ? ` · removed ${new Date(a.removed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
        </div>
        {status === 'pending' && (
          <div className="mt-2 text-small text-neutral-900">
            {requested ? <>Asked {requested.to} to connect {since(requested.at)}.{' '}</> : <>Nobody has been asked to connect yet.{' '}</>}
            {!readOnly && !asking && (
              <button type="button" onClick={() => setAsking(true)} className="underline underline-offset-2">{requested ? 'Send again' : 'Request access'}</button>
            )}
            {asking && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && request()} type="email" placeholder="Client's Google email" aria-label="Client email" className={clsx(field, 'min-w-[220px]')} />
                <Button variant="secondary" onClick={request} disabled={busy || !email.includes('@')} className="!px-3 !py-2">Send request</Button>
                <button type="button" onClick={() => setAsking(false)} className="text-small underline underline-offset-2">Cancel</button>
              </div>
            )}
          </div>
        )}
        <ActionNote error={err} />
      </div>
      {status !== 'removed' && !readOnly && (
        <div className="flex shrink-0 flex-col items-end gap-2">
          {confirming ? (
            <div className="flex flex-col items-end gap-2 rounded bg-neutral-50 p-3 text-small">
              <span>Remove {a.display_name}? Checks and emails stop, the client is told, and the history stays readable.</span>
              <div className="flex gap-2">
                <Button onClick={() => act('remove')} disabled={busy} className="!px-3 !py-2">Yes, remove</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)} className="!py-2">Keep it</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {status === 'paused'
                ? <Button variant="secondary" onClick={() => act('resume')} disabled={busy} className="!px-3 !py-2"><Play size={13} aria-hidden /> Resume</Button>
                : <Button variant="secondary" onClick={() => act('pause')} disabled={busy} className="!px-3 !py-2"><Pause size={13} aria-hidden /> Pause</Button>}
              <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy} className="!py-2"><Trash2 size={13} aria-hidden /> Remove</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Accounts() {
  const [showRemoved, setShowRemoved] = useState(false);
  const { data, error } = useAgency(showRemoved ? '/api/agency/accounts?all=1' : '/api/agency/accounts');
  const [bill, setBill] = useState(null);
  const [name, setName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState(false);
  const [addNote, setAddNote] = useState(null);
  const refreshBilling = () => api('/api/agency/billing').then(setBill).catch(() => {});
  useEffect(() => { refreshBilling(); }, []);
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading accounts" />;

  // Connect for the client (fix plan move 14): their email gets one tap that
  // lands their Google login on this account; the first audit runs by itself.
  async function add() {
    if (!name.trim()) return;
    setBusy(true); setAddNote(null);
    try {
      const r = await api('/api/agency/accounts', { method: 'POST', body: { display_name: name.trim(), email: clientEmail.trim() || undefined, website: website.trim() || undefined } });
      setAdded((xs) => [...xs, r.account || { id: `new-${xs.length}`, display_name: name.trim(), status: 'pending', created_at: new Date().toISOString() }]);
      setAddNote(r.requested ? `Added. We asked ${clientEmail.trim()} to connect Google; the account goes live the moment they do.` : 'Added. Use Request access on the row when you have the client\'s email.');
      setName(''); setClientEmail(''); setWebsite('');
      refreshBilling();
    } catch (e) { setAddNote(e.message); }
    setBusy(false);
  }

  const rows = [...(data.accounts || []), ...added];

  return (
    <div>
      <MonoLabel>Accounts</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">Start with one. Add the rest when it earns it.</h1>

      {bill && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <MonoLabel>This cycle</MonoLabel>
            <div className="mt-1 text-h3">${bill.total.toLocaleString()}<span className="text-small text-neutral-900">/mo</span></div>
            <div className="mt-1 text-small text-neutral-900">{bill.accounts} connected × ${bill.rate} (band {bill.band}) + ${bill.platformFee} platform · pending accounts are not billed</div>
          </Card>
          <Card className="p-4">
            <MonoLabel>Add an account today</MonoLabel>
            <div className="mt-1 text-h3">${bill.add_today_prorated}</div>
            <div className="mt-1 text-small text-neutral-900">prorated for the {bill.cycle.daysRemaining} days left in this cycle, then it joins the normal invoice</div>
          </Card>
          <Card className="p-4">
            <MonoLabel>Band position</MonoLabel>
            <div className="mt-1 text-h3">${bill.rate}<span className="text-small text-neutral-900">/account</span></div>
            <div className="mt-1 text-small text-neutral-900">
              {bill.accounts <= 10 ? `From account 11 every account drops to $39 - automatically.` : bill.accounts <= 30 ? `From account 31 every account drops to $35 - automatically.` : 'Best rate - applied to the whole portfolio.'}
            </div>
          </Card>
        </div>
      )}

      <div className="mt-5 flex max-w-m2 overflow-hidden rounded border border-neutral-500 bg-(--ui-well) focus-within:border-(--ui-focus)">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Client name - e.g. Harbor Clinic"
          className="w-full bg-transparent px-4 py-3 text-small outline-none placeholder:text-neutral-800"
          aria-label="New account name"
        />
        <button type="button" onClick={add} disabled={busy} className="flex items-center gap-1.5 whitespace-nowrap bg-(--ui-cta-a) px-4 text-small font-medium text-(--ui-cta-ink) disabled:opacity-40">
          <Plus size={14} aria-hidden /> Add account
        </button>
      </div>
      <div className="mt-2 grid max-w-m2 gap-2 sm:grid-cols-2">
        <input value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} type="email" placeholder="Client's Google email (optional): we ask them to connect" aria-label="Client email" className="rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)" />
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Their website (optional)" aria-label="Client website" className="rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)" />
      </div>
      {addNote && <p className="mt-2 text-tiny text-neutral-900">{addNote}</p>}
      <p className="mt-2 max-w-[72ch] text-tiny text-neutral-900">
        A new account starts as "awaiting Google connection": when you add the client&apos;s email we ask them to connect, and the first audit runs the day they do. If they already use Insyt, their existing account attaches here the moment they accept. Pause an account any time: paused accounts keep their history but are not checked, not emailed and not billed.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {rows.map((a) => <AccountRow key={a.id} a={a} onAction={refreshBilling} />)}
      </div>
      <button type="button" onClick={() => setShowRemoved((v) => !v)} className="mt-3 font-mono text-tiny uppercase tracking-wide text-neutral-900 underline underline-offset-2">
        {showRemoved ? 'Hide removed accounts' : 'Show removed accounts'}
      </button>

      <p className="mt-6 max-w-[76ch] border-t border-neutral-200 pt-4 text-tiny text-neutral-900">
        What we bill you is the whole money story here. The platform never asks what you charge your clients, never stores your client fees, and takes no share of them - your commercial relationship with your clients is yours alone.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- brand kit

function Brand() {
  const { data, error } = useAgency('/api/agency/brand');
  const [kit, setKit] = useState(null);
  const [saved, setSaved] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setKit(data.kit || { display_name: '', color_primary: '#0B1F2A', color_accent: '#E07A3F', footer_text: '' }); }, [data]);
  if (error) return <ErrorNote message={error.message} />;
  if (!kit) return <Spinner label="Loading brand kit" />;

  async function save() {
    setBusy(true); setSaved(null); setSaveErr(null);
    try {
      const r = await api('/api/agency/brand', { method: 'POST', body: kit });
      setSaved(r.version ? `Saved as version ${r.version}. Earlier reports keep the version they shipped with.` : 'Saved.');
    } catch (e) { setSaveErr(e); }
    setBusy(false);
  }
  const field = (label, key, type = 'text') => (
    <label className="block">
      <MonoLabel>{label}</MonoLabel>
      <input
        type={type}
        value={kit[key] || ''}
        onChange={(e) => setKit({ ...kit, [key]: e.target.value })}
        className={clsx('mt-1 w-full rounded border border-neutral-500 bg-(--ui-well) px-3 py-2.5 text-small outline-none focus:border-(--ui-focus)', type === 'color' && 'h-11 p-1')}
      />
    </label>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <MonoLabel>Brand kit {kit.version ? `· v${kit.version}` : ''}</MonoLabel>
        <h1 className="mt-1 text-h3 tracking-tight">Your reports, your name on them</h1>
        <p className="mt-1 text-small text-neutral-900">
          Your name, logo and primary colour head every report a managed client receives, in the email and the web view, with your footer line at the end. This console stays Insyt-branded - it&apos;s your back office. Versioned: a rebrand never alters reports already in client hands.
        </p>
        <div className="mt-5 flex flex-col gap-4">
          {field('Report display name', 'display_name')}
          <div className="grid grid-cols-2 gap-4">
            {field('Primary colour', 'color_primary', 'color')}
            {field('Accent colour', 'color_accent', 'color')}
          </div>
          {field('Logo URL (light backgrounds)', 'logo_light_url')}
          {field('Footer line', 'footer_text')}
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save new version'}</Button>
            {saved && <span className="text-small text-success">{saved}</span>}
          </div>
          <ActionNote error={saveErr} className="!mt-0" />
        </div>
      </div>
      <div>
        <MonoLabel>Live preview</MonoLabel>
        <div className="mt-1 overflow-hidden rounded border border-neutral-300 bg-card">
          <div className="flex items-center justify-between px-5 py-4" style={{ background: kit.color_primary || '#0B1F2A' }}>
            <span className="text-h5 font-semibold text-white">{kit.display_name || 'Your agency'}</span>
            <span className="font-mono text-tiny uppercase tracking-[0.12em] text-white/70">Weekly report</span>
          </div>
          <div className="p-5">
            <div className="text-h4">Glow Studio - 7 findings, biggest money first</div>
            <div className="mt-2 h-2 w-40 rounded-full" style={{ background: kit.color_accent || '#E07A3F' }} />
            <p className="mt-3 text-small text-neutral-900">Dual primary conversion actions are double-counting purchases…</p>
            <div className="mt-5 border-t border-neutral-200 pt-3 text-tiny text-neutral-900">{kit.footer_text || 'Footer line appears here'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- seats

function Seats() {
  const { data, error } = useAgency('/api/agency/seats');
  const { data: me } = useAgency('/api/agency/me');
  const [seats, setSeats] = useState(null);
  const [form, setForm] = useState({ email: '', name: '', role: 'am' });
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);
  const [removing, setRemoving] = useState(null);
  useEffect(() => { if (data) setSeats(data.seats); }, [data]);
  if (error) return <ErrorNote message={error.message} />;
  if (!data || !seats) return <Spinner label="Loading seats" />;
  const roleLabel = { admin: 'Admin - billing, brand, seats, all accounts', am: 'Account manager - assigned accounts, plus any nobody is assigned to', readonly: 'Read-only - sees everything, changes nothing' };
  const isAdmin = !me || !me.seat || me.seat.role === 'admin';
  const myId = me && me.seat ? me.seat.id : null;
  async function seatAction(id, kind) {
    setBusy(id); setErr(null); setNote(null);
    try {
      if (kind === 'resend') {
        const r = await api(`/api/agency/seats/${id}/resend`, { method: 'POST', body: {} });
        setSeats((xs) => xs.map((s) => (s.id === id ? { ...s, invite: (r.invite && r.invite.status !== 'failed') ? { status: r.invite.status, at: r.invite.at } : { status: 'failed', at: null } } : s)));
      } else {
        await api(`/api/agency/seats/${id}`, { method: 'POST', body: { status: kind } });
        setSeats((xs) => (kind === 'removed' ? xs.filter((s) => s.id !== id) : xs.map((s) => (s.id === id ? { ...s, status: kind } : s))));
      }
    } catch (e) { setErr(e); }
    setBusy(null);
  }
  const inviteLine = (s) => {
    if (s.status !== 'invited' || !s.invite) return null;
    if (s.invite.status === 'failed' || s.invite.status === 'missing') return 'The invite email could not be sent. Resend it.';
    if (s.invite.status === 'sent' || s.invite.status === 'delivered') return `Invite sent ${since(s.invite.at)}. Not joined yet.`;
    if (s.invite.status === 'suppressed' || s.invite.status === 'bounced') return 'The invite email bounced. Check the address, then resend.';
    return `Invite on its way (${since(s.invite.at)}).`;
  };
  // The door (fix plan move 14): add a seat, and the invite goes out with a
  // seven-day link that signs them in with Google and binds the seat.
  async function add() {
    if (!form.email.includes('@')) return;
    setBusy('add'); setNote(null); setErr(null);
    try {
      const r = await api('/api/agency/seats', { method: 'POST', body: form });
      if (r.resent) {
        setSeats((xs) => xs.map((s) => (s.id === r.seat.id ? { ...s, invite: r.seat.invite || s.invite } : s)));
        setNote(`${form.email} was already invited, so we sent the invite again.`);
      } else {
        setSeats((xs) => [...xs, r.seat || { id: `new-${xs.length}`, ...form, status: 'invited' }]);
        setNote(`Invited ${form.email}. The email carries a link that signs them in with Google; it only works for that address.`);
      }
      setForm({ email: '', name: '', role: 'am' });
    } catch (e) { setErr(e); }
    setBusy(null);
  }
  async function setRole(id, role) {
    setBusy(id); setErr(null);
    try { await api(`/api/agency/seats/${id}`, { method: 'POST', body: { role } }); setSeats((xs) => xs.map((s) => (s.id === id ? { ...s, role } : s))); } catch (e) { setErr(e); }
    setBusy(null);
  }
  const field = 'rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  return (
    <div>
      <MonoLabel>Seats &amp; roles</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{seats.length} seats</h1>
      <ActionNote error={err} />
      <div className="mt-5 flex flex-col gap-2">
        {seats.map((s) => (
          <Card key={s.id} className={clsx('flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:justify-between', s.status === 'disabled' && 'opacity-70')}>
            <div className="min-w-0">
              <div className="text-body font-medium">
                {s.name || s.email}
                {s.status === 'invited' && <span className="ml-1 rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">invited</span>}
                {s.status === 'disabled' && <span className="ml-1 rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">disabled</span>}
                {s.id === myId && <span className="ml-1 font-mono text-tiny uppercase tracking-wide text-neutral-900">you</span>}
              </div>
              <div className="text-small text-neutral-900">{s.email}</div>
              {inviteLine(s) && <div className="mt-1 text-small text-neutral-900">{inviteLine(s)}</div>}
            </div>
            {isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <select value={s.role} onChange={(e) => setRole(s.id, e.target.value)} disabled={busy === s.id} className={field} aria-label={`Role for ${s.name || s.email}`}>
                  <option value="admin">Admin</option><option value="am">Account manager</option><option value="readonly">Read-only</option>
                </select>
                {s.status === 'invited' && <Button variant="secondary" onClick={() => seatAction(s.id, 'resend')} disabled={busy === s.id} className="!px-3 !py-2">Resend invite</Button>}
                {s.id !== myId && s.status === 'active' && <Button variant="ghost" onClick={() => seatAction(s.id, 'disabled')} disabled={busy === s.id} className="!py-2">Disable</Button>}
                {s.id !== myId && s.status === 'disabled' && <Button variant="ghost" onClick={() => seatAction(s.id, 'active')} disabled={busy === s.id} className="!py-2">Enable</Button>}
                {s.id !== myId && (removing === s.id ? (
                  <span className="flex items-center gap-2 text-small">
                    Remove {s.name || s.email}?
                    <Button onClick={() => { setRemoving(null); seatAction(s.id, 'removed'); }} disabled={busy === s.id} className="!px-3 !py-2">Yes, remove</Button>
                    <button type="button" onClick={() => setRemoving(null)} className="underline underline-offset-2">Keep</button>
                  </span>
                ) : (
                  <Button variant="ghost" onClick={() => setRemoving(s.id)} disabled={busy === s.id} className="!py-2"><Trash2 size={13} aria-hidden /> Remove</Button>
                ))}
              </div>
            ) : <div className="text-small text-neutral-900">{roleLabel[s.role] || s.role}</div>}
          </Card>
        ))}
      </div>
      {isAdmin && (
        <Card className="mt-4 p-4">
          <MonoLabel>Add a seat</MonoLabel>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} type="email" placeholder="email" aria-label="Email" className={field} />
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="name" aria-label="Name" className={field} />
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={field} aria-label="Role">
              <option value="am">Account manager</option><option value="admin">Admin</option><option value="readonly">Read-only</option>
            </select>
            <Button variant="secondary" onClick={add} disabled={busy === 'add' || !form.email.includes('@')} className="!px-4 !py-2">Invite</Button>
          </div>
          {note && <p className="mt-2 text-tiny text-neutral-900">{note}</p>}
        </Card>
      )}
      <p className="mt-6 text-tiny text-neutral-900">Every approval, dismissal, sign-off and refusal, by whom, lives under <Link to={demoHref('/app/agency/log')} className="underline underline-offset-2">Settings, Log</Link>: filter by account, page back as far as you like, export a CSV.</p>
    </div>
  );
}

// ---------------------------------------------------------------- audit trail
// Its own screen (agency plan move 12): per-account filter, paging past the
// first hundred, a CSV export, and the detail of each entry rendered.

function detailLine(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const skip = new Set(['account_id', 'change_id', 'draft_id', 'report_id', 'alert_id', 'seat_id', 'batch']);
  return Object.entries(detail).filter(([k, v]) => !skip.has(k) && v != null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');
}

function LogView() {
  const { accounts } = useScope();
  const [account, setAccount] = useState('');
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = (before) => {
    setBusy(true);
    const qs = new URLSearchParams(); if (account) qs.set('account', account); if (before) qs.set('before', before);
    return api(`/api/agency/log${qs.toString() ? `?${qs}` : ''}`).then((d) => {
      const rows = d.entries || [];
      setEntries((xs) => (before ? [...(xs || []), ...rows] : rows));
      setMore(rows.length >= 100);
    }).catch(setError).finally(() => setBusy(false));
  };
  useEffect(() => { setEntries(null); load(null); }, [account]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorNote message={error.message} />;
  const field = 'rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  const csv = `/api/agency/log?format=csv${account ? `&account=${encodeURIComponent(account)}` : ''}`;
  return (
    <div>
      <MonoLabel>Audit trail</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">Every action, by whom</h1>
      <p className="mt-1 max-w-[70ch] text-small text-neutral-900">Approvals, dismissals, snoozes, sign-offs, seat and account changes, brief copies, refused writes, and anything a client did on a shared account. Kept for as long as the agency exists.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className={field} aria-label="Filter by account">
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        <a href={csv} className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small font-medium">Export CSV</a>
      </div>
      {!entries ? <div className="mt-5"><Spinner label="Loading the trail" /></div> : entries.length === 0 ? (
        <div className="mt-5"><EmptyState title="Nothing yet" body="The first approval, dismissal or seat change lands here." /></div>
      ) : (
        <div className="mt-4 overflow-hidden rounded border border-neutral-300 bg-card">
          {entries.map((e) => (
            <div key={e.id || e.created_at + e.event} className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 text-small last:border-0">
              <span>
                <strong>{e.seat ? (e.seat.name || e.seat.email) : (e.detail && e.detail.by === 'client' ? 'the client' : 'system')}</strong> · {e.event.replace(/_/g, ' ')}
                {detailLine(e.detail) && <span className="text-neutral-900"> - {detailLine(e.detail)}</span>}
              </span>
              <span className="shrink-0 font-mono text-tiny text-neutral-900">{new Date(e.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      )}
      {entries && more && <Button variant="secondary" onClick={() => load(entries[entries.length - 1].created_at)} disabled={busy} className="mt-3 !px-4 !py-2">Load earlier</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- account page
// The one new screen (agency plan moves 7 and 8): connection state, the
// latest report, three switches, and what happened to every change after
// the seat said yes, read from the client's own ledger and receipts.

const ACT_STATE = {
  applying: { label: 'applying within the hour', cls: 'bg-info-tint text-info' },
  waiting: { label: 'waiting on the client\'s Google connection', cls: 'bg-warning-tint text-warning' },
  watching: { label: 'applied, watching 48 hours', cls: 'bg-info-tint text-info' },
  verified: { label: 'applied and verified', cls: 'bg-success-tint text-success' },
  inconclusive: { label: 'applied, not enough data to verify', cls: 'bg-neutral-100 text-neutral-900' },
  applied: { label: 'applied', cls: 'bg-success-tint text-success' },
  failed: { label: 'Google refused it', cls: 'bg-critical-tint text-critical' },
  reverted: { label: 'undone', cls: 'bg-neutral-100 text-neutral-900' },
};

function ActivityRow({ item, accountId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);
  const { readOnly } = useScope();
  const st = ACT_STATE[done ? 'reverted' : item.state] || ACT_STATE.applied;
  async function undo() {
    setBusy(true); setErr(null);
    try { await api(`/api/agency/accounts/${accountId}/revert/${item.change_id}`, { method: 'POST', body: {} }); setDone(true); setConfirm(false); onChanged(); } catch (e) { setErr(e); }
    setBusy(false);
  }
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-body font-medium">{item.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-tiny text-neutral-900">
            <span className={clsx('rounded-full px-2 py-0.5 font-mono', st.cls)}>{st.label}</span>
            {item.money_monthly_usd ? <span>~${item.money_monthly_usd}/mo</span> : null}
            <span>approved {new Date(item.approved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
            {item.applied_at && <span>· applied {new Date(item.applied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
            {item.verified_at && <span>· verified {new Date(item.verified_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
          </div>
          {item.line && <p className="mt-1 text-small text-neutral-900">{item.line}</p>}
        </div>
        {item.can_undo && !done && !readOnly && (
          confirm ? (
            <span className="flex items-center gap-2 text-small">
              Undo this change on the client&apos;s account?
              <Button onClick={undo} disabled={busy} className="!px-3 !py-2">Yes, undo</Button>
              <button type="button" onClick={() => setConfirm(false)} className="underline underline-offset-2">Keep</button>
            </span>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)} disabled={busy} className="!py-2"><Undo2 size={13} aria-hidden /> Undo</Button>
          )
        )}
      </div>
      <ActionNote error={err} />
    </Card>
  );
}

function AccountPage({ id }) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { data: seatsData } = useAgency('/api/agency/seats');
  const { data: me } = useAgency('/api/agency/me');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [saved, setSaved] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => { api(`/api/agency/accounts/${id}`).then(setData).catch(setError); }, [id, version]);
  if (error) return <ErrorNote message={error.status === 404 ? 'This account is not in your portfolio.' : error.message} />;
  if (!data) return <Spinner label="Loading account" />;
  const { account, tenant, connection, latest_report: report, runs, activity, history } = data;
  const isAdmin = !me || !me.seat || me.seat.role === 'admin';
  const lastRun = (runs || []).find((r) => r.status === 'complete' || r.status === 'degraded');
  const st = ACC_STATUS[account.status] || ACC_STATUS.active;
  const connLine = connection === 'connected'
    ? `Connected${lastRun && lastRun.finished_at ? ` · last check ${new Date(lastRun.finished_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ' · no check yet'}`
    : connection === 'reconnect' ? 'The client\'s Google connection needs renewing. Approvals wait until they reconnect; we have emailed them a one-tap link.'
      : `Not connected yet.${account.request_sent_at ? ` Asked ${account.request_email} to connect ${since(account.request_sent_at)}.` : ' Nobody has been asked to connect; use Request access on the Accounts screen.'}`;
  async function save(patch) {
    setSaving(true); setSaveErr(null); setSaved(null);
    try {
      await api(`/api/agency/accounts/${id}/settings`, { method: 'POST', body: patch });
      setSaved('Saved.'); setVersion((v) => v + 1);
    } catch (e) { setSaveErr(e); }
    setSaving(false);
  }
  const field = 'rounded border border-neutral-500 bg-(--ui-well) px-3 py-2 text-small outline-none focus:border-(--ui-focus)';
  const seats = ((seatsData && seatsData.seats) || []).filter((x) => x.status === 'active');
  return (
    <div>
      <Link to={demoHref('/app/agency/accounts')} className="font-mono text-tiny uppercase tracking-wide text-neutral-900 underline underline-offset-2">← Accounts</Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-h3 tracking-tight">{account.display_name}</h1>
        <StatusChip st={st} />
        {account.brief_only && <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">brief-only</span>}
      </div>
      <p className={clsx('mt-1 max-w-[70ch] text-small', connection === 'connected' ? 'text-neutral-900' : 'text-warning')}>{connLine}</p>
      <div className="mt-1 font-mono text-tiny uppercase tracking-wide text-neutral-900">
        {tenant && tenant.website_url ? `${tenant.website_url} · ` : ''}{account.seat ? account.seat.name : 'Unassigned'} · {account.report_register} report · added {new Date(account.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {report ? (
          <a href={report.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2 text-small font-medium">
            Latest report · {new Date(report.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{report.review_status === 'pending' ? ' · awaiting your review' : ''}
          </a>
        ) : <span className="rounded border border-neutral-300 px-4 py-2 text-small text-neutral-900">No report yet</span>}
        <Link to={demoHref(`/app/agency/triage?account=${account.id}`)} className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2 text-small font-medium">Triage for this account <ArrowRight size={13} aria-hidden /></Link>
      </div>

      {isAdmin && (
        <Card className="mt-6 p-4">
          <MonoLabel>Settings</MonoLabel>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={!!account.brief_only} onChange={(e) => save({ brief_only: e.target.checked })} disabled={saving} className="size-4 accent-(--ui-cta-a)" />
              Brief-only: we propose, you apply by hand
            </label>
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={account.review_reports !== false} onChange={(e) => save({ review_reports: e.target.checked })} disabled={saving} className="size-4 accent-(--ui-cta-a)" />
              Hold reports for a seat&apos;s review before the client sees them
            </label>
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={!!account.client_copy} onChange={(e) => save({ client_copy: e.target.checked })} disabled={saving} className="size-4 accent-(--ui-cta-a)" />
              Copy the client on report and alert emails (no approve links)
            </label>
            <label className="flex flex-col gap-1 text-small">
              <span>The client&apos;s own app</span>
              <select value={account.client_mode || 'shared'} onChange={(e) => save({ client_mode: e.target.value })} disabled={saving} className={field}>
                <option value="shared">Shared - they can approve too; every action is logged here</option>
                <option value="read_only">Read only - approvals and undo stay with you</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-small">
              <span>Report register</span>
              <select value={account.report_register} onChange={(e) => save({ report_register: e.target.value })} disabled={saving} className={field}>
                <option value="simple">Simple - the client&apos;s words</option>
                <option value="technical">Technical - the working shown</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-small">
              <span>Assigned seat</span>
              <select value={account.seat_id || ''} onChange={(e) => save({ seat_id: e.target.value || null })} disabled={saving} className={field}>
                <option value="">Unassigned - every account manager sees it</option>
                {seats.map((x) => <option key={x.id} value={x.id}>{x.name || x.email}</option>)}
              </select>
            </label>
          </div>
          {saved && <p className="mt-2 text-small text-success">{saved}</p>}
          <ActionNote error={saveErr} />
        </Card>
      )}

      <div className="mt-8">
        <MonoLabel>What happened after yes</MonoLabel>
        {activity.length === 0 ? (
          <div className="mt-2"><EmptyState title="Nothing approved yet" body="Every change you approve for this account lands here with what happened next: applied, verified, refused, or waiting." /></div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">{activity.map((it) => <ActivityRow key={it.change_id} item={it} accountId={account.id} onChanged={() => setVersion((v) => v + 1)} />)}</div>
        )}
      </div>

      <div className="mt-8">
        <button type="button" onClick={() => setShowHistory((v) => !v)} className="font-mono text-tiny uppercase tracking-wide text-neutral-900 underline underline-offset-2">
          {showHistory ? 'Hide the client\'s history' : `The client's history (${history.length})`}
        </button>
        {showHistory && (
          <div className="mt-2 overflow-hidden rounded border border-neutral-300 bg-card">
            {history.map((h, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 text-small last:border-0">
                <span>{h.text}</span>
                <span className="shrink-0 font-mono text-tiny text-neutral-900">{new Date(h.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
            {history.length === 0 && <div className="px-4 py-3 text-small text-neutral-900">Nothing yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lenses
// Portfolio and Pacing are two views of the same accounts; Triage, Alerts
// and Review are three queues of the same daily work; Brand and Seats are
// both monthly config. Segments are real links, so every pre-restructure
// URL still lands exactly where it used to.

function PortfolioView({ lens }) {
  return (
    <div>
      <Segments
        className="mb-5"
        items={[
          { label: 'Health', to: demoHref('/app/agency'), active: lens !== 'pacing' },
          { label: 'Pacing', to: demoHref('/app/agency/pacing'), active: lens === 'pacing' },
        ]}
      />
      {lens === 'pacing' ? <Pacing /> : <Portfolio />}
    </div>
  );
}

function WorkView({ queue, counts }) {
  return (
    <div>
      <Segments
        className="mb-5"
        items={[
          { label: 'Triage', to: demoHref('/app/agency/triage'), active: queue === 'triage', count: counts.triage },
          { label: 'Alerts', to: demoHref('/app/agency/alerts'), active: queue === 'alerts', count: counts.alerts },
          { label: 'Review', to: demoHref('/app/agency/review'), active: queue === 'review', count: counts.review },
        ]}
      />
      {queue === 'alerts' ? <Alerts /> : queue === 'review' ? <Review /> : <Triage />}
    </div>
  );
}

function AgencySettingsView({ pane }) {
  return (
    <div>
      <Segments
        className="mb-5"
        items={[
          { label: 'Brand', to: demoHref('/app/agency/brand'), active: pane !== 'seats' },
          { label: 'Seats', to: demoHref('/app/agency/seats'), active: pane === 'seats' },
          { label: 'Log', to: demoHref('/app/agency/log'), active: pane === 'log' },
        ]}
      />
      {pane === 'seats' ? <Seats /> : pane === 'log' ? <LogView /> : <Brand />}
    </div>
  );
}

// ---------------------------------------------------------------- shell

function AgencyRoutes() {
  const { path } = useRouter();
  const { data: me, error } = useAgency('/api/agency/me');
  const { data: accData } = useAgency('/api/agency/accounts');
  const { data: campData } = useAgency('/api/agency/campaigns');
  const [scope, setScopeState] = useState(readScopeFromUrl);
  const setScope = (next) => { setScopeState(next); writeScopeToUrl(next); };
  // Tab links replace the URL without query params - re-stamp the scope so a
  // scoped view stays bookmarkable wherever you navigate.
  useEffect(() => { writeScopeToUrl(scope); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeValue = useMemo(() => {
    const accounts = (accData && accData.accounts) || [];
    const meName = me && me.seat ? me.seat.name : null;
    const mineNames = meName
      ? new Set(accounts.filter((a) => a.seat && a.seat.name === meName).map((a) => a.display_name))
      : null;
    return {
      scope, setScope, accounts, meName, mineNames,
      readOnly: !!(me && me.seat && me.seat.role === 'readonly'),
      campaigns: (campData && campData.campaigns) || [],
    };
  }, [scope, accData, campData, me]);

  const workCounts = useWorkCounts(path);
  const workTotal = workCounts.triage + workCounts.alerts + workCounts.review;

  let screen = <PortfolioView lens="health" />;
  if (path === '/app/agency/pacing') screen = <PortfolioView lens="pacing" />;
  if (path === '/app/agency/work' || path === '/app/agency/triage') screen = <WorkView queue="triage" counts={workCounts} />;
  if (path === '/app/agency/alerts') screen = <WorkView queue="alerts" counts={workCounts} />;
  if (path === '/app/agency/review') screen = <WorkView queue="review" counts={workCounts} />;
  if (path === '/app/agency/build') screen = <Build />;
  if (path === '/app/agency/accounts') screen = <Accounts />;
  {
    const m = /^\/app\/agency\/accounts\/([^/]+)$/.exec(path);
    if (m) screen = <AccountPage id={m[1]} />;
  }
  if (path === '/app/agency/settings' || path === '/app/agency/brand') screen = <AgencySettingsView pane="brand" />;
  if (path === '/app/agency/seats') screen = <AgencySettingsView pane="seats" />;
  if (path === '/app/agency/log') screen = <AgencySettingsView pane="log" />;

  if (error && error.status === 401 && !isDemo()) {
    return (
      <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
        <MonoLabel>Insyt for agencies</MonoLabel>
        <h1 className="mt-2 text-h2 tracking-tight">Sign in</h1>
        <div className="mt-6"><Button href="/auth/google/start?step=discovery">Continue with Google</Button></div>
      </div>
    );
  }
  if (error && error.status === 403 && !isDemo()) {
    const disabled = error.data && error.data.code === 'seat_disabled';
    return (
      <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
        <h1 className="text-h3">{disabled ? 'Your seat is disabled.' : 'This sign-in has no agency seat.'}</h1>
        <p className="mt-2 text-small text-neutral-900">{disabled ? error.message : 'Ask your agency admin for an invite, or contact us to set up your agency.'}</p>
      </div>
    );
  }
  // One login, several agencies (agency plan move 4): a switcher in the header.
  async function switchAgency(agencyId) {
    try { await api('/api/agency/switch', { method: 'POST', body: { agency_id: agencyId } }); window.location.reload(); } catch { /* the header keeps the current one */ }
  }

  return (
    <ScopeContext.Provider value={scopeValue}>
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-neutral-300 bg-page/85 backdrop-blur">
        <div className="mx-auto flex max-w-xl2 items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <Link to={demoHref('/app/agency')} className="flex items-center"><Wordmark className="h-8" /></Link>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">Agency</span>
            {me && me.agencies && me.agencies.length > 1 ? (
              <select value={me.agency ? me.agency.id : ''} onChange={(e) => switchAgency(e.target.value)} className="rounded border border-neutral-400 bg-(--ui-well) px-2 py-1 text-small outline-none" aria-label="Agency">
                {me.agencies.map((a) => <option key={a.id} value={a.id}>{a.name || 'Agency'}</option>)}
              </select>
            ) : me && me.agency && <span className="hidden text-small text-neutral-900 sm:inline">{me.agency.name}</span>}
          </div>
          <div className="flex items-center gap-3">
            {isDemo() && <MonoLabel>Preview with sample data</MonoLabel>}
            <ThemeToggle />
          </div>
        </div>
        <nav className="mx-auto flex max-w-xl2 gap-1 overflow-x-auto px-3 pb-2" aria-label="Agency">
          {NAV.map((n) => {
            const { to, label, icon: IconEl } = n;
            const active = n.match ? n.match.includes(path) : (path === to || path.startsWith(`${to}/`));
            return (
              <Link
                key={to}
                to={demoHref(to)}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-small font-medium',
                  active ? 'bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) text-(--ui-cta-ink) ring-1 ring-inset ring-(--ui-cta-edge) shadow-[inset_0_1px_0_var(--ui-cta-hi)]' : 'text-neutral-900 hover:bg-neutral-100',
                )}
              >
                <IconEl size={14} aria-hidden /> {label}
                {n.badge && <CountBadge n={workTotal} inverted={active} />}
              </Link>
            );
          })}
        </nav>
      </header>
      <ScopeBar />
      <main className="page-fade mx-auto max-w-xl2 px-5 pb-24 pt-8">{screen}</main>
      <footer className="mx-auto max-w-xl2 px-5 pb-10 text-tiny text-neutral-900">
        <Undo2 size={12} className="mr-1 inline" aria-hidden />
        No auto-apply, ever. Changes land on client accounts under your name - every one waits for a seat&apos;s explicit approval, is applied with the client&apos;s own Google connection, and is watched for 48 hours with an undo on the account page.
      </footer>
    </div>
    </ScopeContext.Provider>
  );
}

export default function Agency() {
  return <AgencyRoutes />;
}
