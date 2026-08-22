// Agency console - master §13. Portfolio grid, triage queue, report review,
// brand kit, seats. Register inverts here: full technical vocabulary (this
// tree is exempt from the customer jargon lint). Binding rule everywhere:
// no auto-apply, no auto-publish - every action is an explicit seat click.

import React, { useContext, useEffect, useMemo, useState, createContext } from 'react';
import clsx from 'clsx';
import {
  LayoutGrid01 as LayoutGrid, CheckDone01 as ListChecks, FileCheck02 as FileCheck2, Palette,
  Users01 as Users, ArrowRight, FlipBackward as Undo2, Copy01 as Copy, Check, X, Zap,
  Building02 as Building2, Plus, PauseCircle as Pause, Play, Trash01 as Trash2, SearchMd as Search,
  Speedometer03 as Gauge, Bell01 as Bell, Clock, Tool02 as Hammer,
} from '@untitledui/icons';
import { api, isDemo, demoHref } from '../lib/api.js';
import { RouterProvider, useRouter, Link } from '../lib/router.jsx';
import { MonoLabel, Button, Card, Spinner, EmptyState, ErrorNote, useCountUp, BrandOrb, Wordmark, ProgressRing, SEV_HEX, ThemeToggle } from '../lib/ui.jsx';

const NAV = [
  { to: '/app/agency', label: 'Portfolio', icon: LayoutGrid },
  { to: '/app/agency/triage', label: 'Triage', icon: ListChecks },
  { to: '/app/agency/pacing', label: 'Pacing', icon: Gauge },
  { to: '/app/agency/alerts', label: 'Alerts', icon: Bell },
  { to: '/app/agency/build', label: 'Build', icon: Hammer },
  { to: '/app/agency/review', label: 'Review', icon: FileCheck2 },
  { to: '/app/agency/accounts', label: 'Accounts', icon: Building2 },
  { to: '/app/agency/brand', label: 'Brand', icon: Palette },
  { to: '/app/agency/seats', label: 'Seats', icon: Users },
];

const SEV = { critical: 'critical', warning: 'warning', info: 'info' };

function useAgency(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api(path).then(setData).catch((e) => setError(e)); }, [path]);
  return { data, error };
}

// ---------------------------------------------------------------- scope
// The scope bar is a LENS, not navigation: Account > Campaign narrows every
// screen in place (the stream stays money-sorted). Default is always
// All accounts - the cross-portfolio stream is the product. Scope rides in
// the URL so an account view is bookmarkable for the weekly client call.

const ScopeContext = createContext({ scope: { account: null, campaign: null, mine: false }, setScope: () => {}, accounts: [], campaigns: [], mineNames: null, meName: null });
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
              scope.mine ? 'border-transparent bg-(--ui-cta-a) text-page' : 'border-neutral-400 bg-(--ui-well) text-neutral-900')}
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
  const { data: credits } = useAgency('/api/agency/credits');
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
        {credits && (
          <div className="flex items-center gap-2 rounded border border-neutral-300 bg-card px-3 py-2 text-small">
            <Zap size={14} className="text-info" aria-hidden />
            <span className="font-semibold">{credits.balance}</span> audit credits
            <span className="text-neutral-900"> -  run a white-labelled prospect audit to pitch a new client</span>
          </div>
        )}
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
            <div className="flex items-center justify-between border-t border-neutral-200 pt-2.5 text-tiny text-neutral-900">
              <span>Last report {a.last_report_at ? new Date(a.last_report_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ' - '}</span>
              <Link to={demoHref('/app/agency/triage')} className="inline-flex items-center gap-1 underline underline-offset-2">
                Triage <ArrowRight size={12} aria-hidden />
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
  const [ownState, setState] = useState(null); // null | approved | dismissed | snoozing | snoozed | copied
  const [snoozeReason, setSnoozeReason] = useState('');
  const [snoozedUntil, setSnoozedUntil] = useState(null);
  const [busy, setBusy] = useState(false);
  const state = forcedState || ownState;

  async function act(kind) {
    setBusy(true);
    try {
      await api(`/api/agency/${kind}/${item.id}`, { method: 'POST', body: kind === 'dismiss' ? { reason: 'dismissed from triage' } : {} });
      setState(kind === 'approve' ? 'approved' : 'dismissed');
      onDone();
    } catch (e) { setState(null); }
    setBusy(false);
  }
  async function snooze(days) {
    setBusy(true);
    try {
      const r = await api(`/api/agency/snooze/${item.id}`, { method: 'POST', body: { days, reason: snoozeReason.trim() || null } });
      setSnoozedUntil(r.until || new Date(Date.now() + days * 86_400_000).toISOString());
      setState('snoozed');
      onDone();
    } catch { setState(null); }
    setBusy(false);
  }
  function copyBrief() {
    const brief = [
      `${item.account} - ${item.title}`,
      `Rule ${item.rule_id} (layer ${item.layer}) · ${item.severity}${item.money_monthly_usd ? ` · ~$${item.money_monthly_usd}/mo` : ''}`,
      '', item.explanation, '',
      `BEFORE: ${JSON.stringify(item.before)}`, `AFTER:  ${JSON.stringify(item.after)}`,
    ].join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(brief).catch(() => {});
    setState('copied');
    setTimeout(() => setState((s) => (s === 'copied' ? null : s)), 1600);
  }

  if (state === 'approved' || state === 'dismissed') {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approved' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} className="text-neutral-900" aria-hidden />}
        {item.account}: {state === 'approved' ? 'approved - executor will apply and verify' : 'dismissed with reason'} · logged to the audit trail
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
          {onSelect && !item.brief_only && (
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
        {item.build_template ? (
          <Link
            to={demoHref(`/app/agency/build?template=${item.build_template}&for=${encodeURIComponent(item.account)}`)}
            className="inline-flex items-center gap-1.5 rounded bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) px-4 py-2 text-small font-medium text-page ring-1 ring-inset ring-(--ui-cta-edge) shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_var(--ui-cta-hi)]"
          >
            <Hammer size={13} aria-hidden /> Build it
          </Link>
        ) : !item.brief_only && (
          <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Apply</Button>
        )}
        <Button variant="secondary" onClick={copyBrief} className="!px-4 !py-2">
          <Copy size={13} aria-hidden /> {state === 'copied' ? 'Copied' : 'Copy fix brief'}
        </Button>
        <Button variant="ghost" onClick={() => act('dismiss')} disabled={busy} className="!py-2">Dismiss with reason</Button>
        {state !== 'snoozing' && (
          <Button variant="ghost" onClick={() => setState('snoozing')} disabled={busy} className="!py-2">
            <Clock size={13} aria-hidden /> Snooze
          </Button>
        )}
        {item.brief_only && <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">brief-only account - Apply disabled</span>}
      </div>
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
  const [busy, setBusy] = useState(false);
  const { scope, accounts, mineNames } = useScope();
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading triage queue" />;

  const nowMs = Date.now();
  const isSnoozed = (i) => i.snoozed_until && Date.parse(i.snoozed_until) > nowMs;
  const scoped = applyScope((data.queue || []).filter((i) => !isSnoozed(i)), scope, accounts, mineNames);
  const snoozed = applyScope((data.queue || []).filter(isSnoozed), scope, accounts, mineNames);
  const snoozedAll = [...snoozed.items, ...(snoozed.accountWide || [])];
  const { items: queue, accountWide } = scoped;

  const toggle = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const selIds = Object.keys(sel).filter((id) => sel[id] && !batched.has(id));
  const allItems = [...queue, ...(accountWide || [])];
  const selMoney = selIds.reduce((n, id) => n + ((allItems.find((i) => i.id === id) || {}).money_monthly_usd || 0), 0);

  async function approveSelected() {
    setBusy(true);
    try {
      await api('/api/agency/approve-batch', { method: 'POST', body: { ids: selIds } });
      setBatched((b) => new Set([...b, ...selIds]));
      setSel({});
    } catch { /* keep selection */ }
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
        Every change ships both ways: Apply (our executor runs it through the staged workspace → diff → publish → verify path) or Copy fix brief for manual execution. Nothing is ever auto-applied. Tick several and approve them in one go - each still lands individually in the per-seat audit log. Snooze parks an item with a reason; it comes back by itself.
      </p>
      {selIds.length > 0 && (
        <div className="sticky top-[105px] z-20 mt-4 flex flex-wrap items-center gap-3 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2.5 shadow-sm">
          <span className="text-small font-semibold">{selIds.length} selected{selMoney ? ` · ~$${selMoney}/mo total` : ''}</span>
          <Button onClick={approveSelected} disabled={busy} className="!px-4 !py-2">Approve {selIds.length} selected</Button>
          <button type="button" onClick={() => setSel({})} className="text-small text-neutral-900 underline underline-offset-2">Clear</button>
        </div>
      )}
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
      {snoozedAll.length > 0 && (
        <div className="mt-8 border-t border-neutral-200 pt-4">
          <button type="button" onClick={() => setShowSnoozed((s) => !s)} className="flex items-center gap-2 font-mono text-tiny uppercase tracking-wide text-neutral-900">
            <Clock size={13} aria-hidden /> Snoozed ({snoozedAll.length}) {showSnoozed ? ' -  hide' : ' -  show'}
          </button>
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
  async function ack() {
    setBusy(true);
    try { await api(`/api/agency/alerts/${a.id}/ack`, { method: 'POST', body: {} }); setAcked(true); } catch { /* keep */ }
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
        ) : (
          <Button variant="secondary" onClick={ack} disabled={busy} className="!px-4 !py-2">Acknowledge</Button>
        )}
      </div>
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
        Breakage and fast movers that can&apos;t wait for the weekly run: tags going dark, spend spikes, disapprovals, conversion flatlines. A daily digest of unacknowledged alerts emails every seat each morning - acknowledging here keeps it out of the digest. Alerts only ever notify; fixes still go through triage.
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
  created_paused: { label: 'created - paused', cls: 'bg-info-tint text-info', dot: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  enabled: { label: 'enabled', cls: 'bg-success-tint text-success', dot: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
};

function DraftCard({ d, index }) {
  const [status, setStatus] = useState(d.status);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const spec = d.spec || {};

  async function act(action) {
    setBusy(true);
    try {
      const r = await api(`/api/agency/drafts/${d.id}/${action}`, { method: 'POST', body: {} });
      setStatus(r.status || (action === 'approve' ? 'created_paused' : action === 'enable' ? 'enabled' : 'dismissed'));
    } catch { /* keep */ }
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
        {status === 'draft' && (
          <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Create in Google Ads - paused</Button>
        )}
        {status === 'created_paused' && (
          <Button onClick={() => act('enable')} disabled={busy} className="!px-4 !py-2"><Play size={13} aria-hidden /> Enable - starts spending</Button>
        )}
        <Button variant="secondary" onClick={copyBrief} className="!px-4 !py-2">
          <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy build brief'}
        </Button>
        {status !== 'enabled' && (
          <Button variant="ghost" onClick={() => act('dismiss')} disabled={busy} className="!py-2">Dismiss</Button>
        )}
        {status === 'created_paused' && <span className="font-mono text-tiny uppercase tracking-wide text-neutral-900">paused - spends nothing until enabled</span>}
        {status === 'enabled' && <span className="font-mono text-tiny uppercase tracking-wide text-success">live · one-tap pause any time</span>}
      </div>
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
  useEffect(() => { if (prefillAccount && !form.account_id) setForm((f) => ({ ...f, account_id: prefillAccount })); }, [prefillAccount]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading drafts" />;

  async function create() {
    if (!form.account_id) return;
    setBusy(true);
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
    } catch { /* keep form */ }
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
  async function act(kind) {
    setBusy(true);
    try {
      await api(`/api/agency/report/${r.id}/${kind}`, { method: 'POST', body: kind === 'reject' ? { reason: 'needs edits' } : {} });
      setState(kind);
    } catch { /* keep row */ }
    setBusy(false);
  }
  if (state) {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        {state === 'approve' ? <Check size={15} className="text-success" aria-hidden /> : <X size={15} aria-hidden />}
        {r.account}: report {state === 'approve' ? 'approved - now visible in the client library' : 'sent back'}
      </Card>
    );
  }
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-body font-semibold">{r.account}</div>
        <div className="mt-0.5 text-small text-neutral-900">
          {r.type === 'deep' ? 'Deep audit' : 'Weekly report'} · rendered {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · white-labelled PDF + web view
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <a href={demoHref('/app/report')} className="inline-flex items-center gap-1.5 rounded border border-neutral-500 bg-(--ui-well) px-4 py-2 text-small font-medium">Preview</a>
        <Button onClick={() => act('approve')} disabled={busy} className="!px-4 !py-2">Approve</Button>
        <Button variant="ghost" onClick={() => act('reject')} disabled={busy} className="!py-2">Send back</Button>
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
        The platform never emails your clients. Reports render into this queue; nothing becomes client-visible until a seat approves it. You distribute however you like.
      </p>
      {queue.length === 0 ? (
        <div className="mt-5"><EmptyState title="Nothing waiting" body="Weekly renders land here after each run." /></div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">{queue.map((r) => <ReviewItem key={r.id} r={r} />)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- accounts + billing

const ACC_STATUS = {
  active: { label: 'active', cls: 'bg-success-tint text-success', dot: 'bg-success', halo: 'color-mix(in srgb, var(--ui-success) 22%, transparent)' },
  pending: { label: 'awaiting Google connection', cls: 'bg-info-tint text-info', dot: 'bg-info', halo: 'color-mix(in srgb, var(--ui-info) 22%, transparent)' },
  paused: { label: 'paused - not checked, not billed', cls: 'bg-neutral-100 text-neutral-900', dot: 'bg-neutral-800', halo: 'var(--ui-ring-strong)' },
};

function AccountRow({ a, onAction }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [status, setStatus] = useState(a.status);
  async function act(kind) {
    setBusy(true);
    try {
      await api(`/api/agency/accounts/${a.id}/${kind}`, { method: 'POST', body: {} });
      if (kind === 'remove') setGone(true);
      else setStatus(kind === 'pause' ? 'paused' : 'active');
      onAction();
    } catch { /* row unchanged */ }
    setBusy(false);
  }
  if (gone) {
    return (
      <Card className="flex items-center gap-2 p-4 text-small text-neutral-900">
        <Check size={15} className="text-success" aria-hidden />
        {a.display_name} removed - billing stops at the end of this cycle; its history and ledger stay readable.
      </Card>
    );
  }
  const st = ACC_STATUS[status] || ACC_STATUS.active;
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold">{a.display_name}</span>
          <StatusChip st={st} />
        </div>
        <div className="mt-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">
          {a.seat ? a.seat.name : 'Unassigned'} · {a.report_register}{a.brief_only ? ' · brief-only' : ''} · added {new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {status === 'paused'
          ? <Button variant="secondary" onClick={() => act('resume')} disabled={busy} className="!px-3 !py-2"><Play size={13} aria-hidden /> Resume</Button>
          : <Button variant="secondary" onClick={() => act('pause')} disabled={busy} className="!px-3 !py-2"><Pause size={13} aria-hidden /> Pause</Button>}
        <Button variant="ghost" onClick={() => act('remove')} disabled={busy} className="!py-2"><Trash2 size={13} aria-hidden /> Remove</Button>
      </div>
    </Card>
  );
}

function Accounts() {
  const { data, error } = useAgency('/api/agency/accounts');
  const [bill, setBill] = useState(null);
  const [name, setName] = useState('');
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState(false);
  const refreshBilling = () => api('/api/agency/billing').then(setBill).catch(() => {});
  useEffect(() => { refreshBilling(); }, []);
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading accounts" />;

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api('/api/agency/accounts', { method: 'POST', body: { display_name: name.trim() } });
      setAdded((xs) => [...xs, r.account || { id: `new-${xs.length}`, display_name: name.trim(), status: 'pending', created_at: new Date().toISOString() }]);
      setName('');
      refreshBilling();
    } catch { /* keep form */ }
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
            <div className="mt-1 text-small text-neutral-900">{bill.accounts} billable × ${bill.rate} (band {bill.band}) + ${bill.platformFee} platform</div>
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
        <button type="button" onClick={add} disabled={busy} className="flex items-center gap-1.5 whitespace-nowrap bg-(--ui-cta-a) px-4 text-small font-medium text-page disabled:opacity-40">
          <Plus size={14} aria-hidden /> Add account
        </button>
      </div>
      <p className="mt-2 max-w-[72ch] text-tiny text-neutral-900">
        A new account starts as "awaiting Google connection" - connect its Ads/GA4/GTM access (or send the client an access request) and the first audit runs the same day. Pause an account any time: paused accounts keep their full history but are not checked and not billed.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {rows.map((a) => <AccountRow key={a.id} a={a} onAction={refreshBilling} />)}
      </div>

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
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setKit(data.kit || { display_name: '', color_primary: '#0B1F2A', color_accent: '#E07A3F', footer_text: '' }); }, [data]);
  if (error) return <ErrorNote message={error.message} />;
  if (!kit) return <Spinner label="Loading brand kit" />;

  async function save() {
    setBusy(true); setSaved(null);
    try {
      const r = await api('/api/agency/brand', { method: 'POST', body: kit });
      setSaved(r.version ? `Saved as version ${r.version}. Earlier reports keep the version they shipped with.` : 'Saved.');
    } catch (e) { setSaved(e.message); }
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
          The kit applies to everything your clients see: the report web view, the PDF, and (Top tier) the portal on your own domain. This console stays Insyt-branded - it&apos;s your back office. Versioned: a rebrand never alters reports already in client hands.
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
  const { data: log } = useAgency('/api/agency/log');
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return <Spinner label="Loading seats" />;
  const roleLabel = { admin: 'Admin - billing, brand, seats, all accounts', am: 'Account manager - scoped to assigned accounts', readonly: 'Read-only' };
  return (
    <div>
      <MonoLabel>Seats &amp; roles</MonoLabel>
      <h1 className="mt-1 text-h3 tracking-tight">{data.seats.length} seats</h1>
      <div className="mt-5 flex flex-col gap-2">
        {data.seats.map((s) => (
          <Card key={s.id} className="flex flex-col items-start gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-body font-medium">{s.name || s.email} {s.status === 'invited' && <span className="ml-1 rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny">invited</span>}</div>
              <div className="text-small text-neutral-900">{s.email}</div>
            </div>
            <div className="text-small text-neutral-900">{roleLabel[s.role] || s.role}</div>
          </Card>
        ))}
      </div>
      {log && (
        <div className="mt-8">
          <MonoLabel>Per-seat audit trail</MonoLabel>
          <div className="mt-2 overflow-hidden rounded border border-neutral-300 bg-card">
            {log.entries.map((e, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 text-small last:border-0">
                <span><strong>{e.seat ? e.seat.name : 'system'}</strong> · {e.event.replace(/_/g, ' ')}{e.detail && e.detail.reason ? ` - “${e.detail.reason}”` : ''}</span>
                <span className="shrink-0 font-mono text-tiny text-neutral-900">{new Date(e.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-tiny text-neutral-900">Every approval, dismissal and report sign-off, by whom, forever. Your record if a client ever asks.</p>
        </div>
      )}
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
      campaigns: (campData && campData.campaigns) || [],
    };
  }, [scope, accData, campData, me]);

  let screen = <Portfolio />;
  if (path === '/app/agency/triage') screen = <Triage />;
  if (path === '/app/agency/pacing') screen = <Pacing />;
  if (path === '/app/agency/alerts') screen = <Alerts />;
  if (path === '/app/agency/build') screen = <Build />;
  if (path === '/app/agency/review') screen = <Review />;
  if (path === '/app/agency/accounts') screen = <Accounts />;
  if (path === '/app/agency/brand') screen = <Brand />;
  if (path === '/app/agency/seats') screen = <Seats />;

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
    return (
      <div className="mx-auto max-w-s2 px-5 pt-20 text-center">
        <h1 className="text-h3">This sign-in has no agency seat.</h1>
        <p className="mt-2 text-small text-neutral-900">Ask your agency admin for an invite, or contact us to set up your agency.</p>
      </div>
    );
  }

  return (
    <ScopeContext.Provider value={scopeValue}>
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-neutral-300 bg-page/85 backdrop-blur">
        <div className="mx-auto flex max-w-xl2 items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <Link to={demoHref('/app/agency')} className="flex items-center"><Wordmark className="h-8" /></Link>
            <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-tiny uppercase tracking-wide text-neutral-900">Agency</span>
            {me && me.agency && <span className="hidden text-small text-neutral-900 sm:inline">{me.agency.name}</span>}
          </div>
          <div className="flex items-center gap-3">
            {isDemo() && <MonoLabel>Preview with sample data</MonoLabel>}
            <ThemeToggle />
          </div>
        </div>
        <nav className="mx-auto flex max-w-xl2 gap-1 overflow-x-auto px-3 pb-2" aria-label="Agency">
          {NAV.map(({ to, label, icon: IconEl }) => {
            const active = path === to;
            return (
              <Link
                key={to}
                to={demoHref(to)}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-small font-medium',
                  active ? 'bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) text-page ring-1 ring-inset ring-(--ui-cta-edge) shadow-[inset_0_1px_0_var(--ui-cta-hi)]' : 'text-neutral-900 hover:bg-neutral-100',
                )}
              >
                <IconEl size={14} aria-hidden /> {label}
              </Link>
            );
          })}
        </nav>
      </header>
      <ScopeBar />
      <main className="page-fade mx-auto max-w-xl2 px-5 pb-24 pt-8">{screen}</main>
      <footer className="mx-auto max-w-xl2 px-5 pb-10 text-tiny text-neutral-900">
        <Undo2 size={12} className="mr-1 inline" aria-hidden />
        No auto-apply, ever. Changes land on client accounts under your name - every one waits for a seat&apos;s explicit approval, and every applied change keeps a one-tap rollback.
      </footer>
    </div>
    </ScopeContext.Provider>
  );
}

export default function Agency() {
  return <AgencyRoutes />;
}
