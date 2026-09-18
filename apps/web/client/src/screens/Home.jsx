// Dashboard home - §11 screen 2. Health, waiting approvals, cumulative value,
// latest report. Every element leads somewhere; empty states sell next steps.
import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Zap, Lock01 as Lock, AlertTriangle, Check } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { useAccess } from '../lib/access.jsx';
import { safeFixes, useBatchApprove } from '../lib/batch.jsx';
import { PerformanceChart } from '../report/charts.jsx';
import { writeStepHref } from '../lib/fix-access.js';
import { MonoLabel, Button, Card, Chip, Spinner, EmptyState, ErrorNote, Sparkline, useCountUp } from '../lib/ui.jsx';

function MiniDial({ score }) {
  const sevColor = score < 50 ? 'var(--ui-critical)' : score < 70 ? 'var(--ui-warning)' : 'var(--ui-success)';
  const r = 40; const cx = 50; const cy = 50; const start = 135; const sweepMax = 270;
  const arc = (from, deg) => {
    const rad = (a) => ((a - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(from)); const y1 = cy + r * Math.sin(rad(from));
    const x2 = cx + r * Math.cos(rad(from + deg)); const y2 = cy + r * Math.sin(rad(from + deg));
    return `M ${x1} ${y1} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const shown = useCountUp(score);
  return (
    <div className="relative h-[100px] w-[100px] shrink-0" role="img" aria-label={`Account health ${score} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <path d={arc(start, sweepMax)} fill="none" strokeWidth="7" strokeLinecap="round" style={{ stroke: 'var(--ui-ring)' }} />
        <path d={arc(start, Math.max((shown / 100) * sweepMax, 3))} fill="none" strokeWidth="7" strokeLinecap="round" style={{ stroke: sevColor }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-h4">{shown}</div>
    </div>
  );
}

// ---------------------------------------------------------------- time helpers
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function ago(iso, now = Date.now()) {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, 'hour', 'hours') + ' ago';
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
function whenChecked(iso, now = Date.now()) {
  if (!iso) return null;
  const days = (now - Date.parse(iso)) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  const d = new Date(iso);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const nextCheck = (days) => (days === 0 ? 'Next check today.' : days === 1 ? 'Next check tomorrow.' : `Next check in ${days} days.`);

// ---------------------------------------------------------------- money strip
// Three tiles (richer-platform spec §2.2): spent, going to waste, recovered.
// Below a plan the third tile is the projection with the "if approved" chip.
// A tile is left out only when its data has never existed; never a blank.
function MoneyStrip({ overview, access, money }) {
  const tiles = [];
  const spend = overview.spend;
  if (spend) {
    tiles.push({
      key: 'spent', label: 'Spent this month', value: money(spend.month_usd),
      sub: spend.month_budget_usd ? `of ${money(spend.month_budget_usd)}${spend.pace_line ? ` · ${spend.pace_line}` : ''}` : spend.pace_line,
    });
  }
  if (overview.roas) {
    // Online shops with order values (fix plan move 11): return on ad spend, waste against it.
    tiles.push({ key: 'roas', label: 'Return on ad spend', value: `${overview.roas.ratio}x`, sub: `${money(overview.roas.value_28d_usd)} back on ${money(overview.roas.spend_28d_usd)}, last 28 days${overview.waste_monthly_usd > 0 ? `, about ${money(overview.waste_monthly_usd)} a month of it wasted` : ''}`, tone: overview.roas.ratio >= 1 ? 'success' : 'critical' });
  } else if (overview.waste_monthly_usd != null) {
    tiles.push({ key: 'waste', label: 'Going to waste', value: money(overview.waste_monthly_usd), per: '/mo', sub: 'from your latest report', tone: overview.waste_monthly_usd > 0 ? 'critical' : null });
  }
  const active = access && access.level === 'active';
  const rec = overview.recovered || { fixes: 0, usd: 0 };
  if (active) {
    tiles.push({ key: 'recovered', label: 'Recovered since you joined', value: money(rec.usd), sub: rec.fixes > 0 ? plural(rec.fixes, 'fix applied', 'fixes applied') : 'first receipt lands 48 hours after your first fix', tone: rec.usd > 0 ? 'success' : null });
  } else if (access && access.pending_count > 0) {
    tiles.push({
      key: 'would', label: 'Would recover', chip: true,
      value: access.pending_value_usd > 0 ? `about ${money(access.pending_value_usd)}` : plural(access.pending_count, 'fix drafted', 'fixes drafted'),
      per: access.pending_value_usd > 0 ? '/mo' : '',
      sub: plural(access.pending_count, 'fix waiting for your yes', 'fixes waiting for your yes'),
    });
  }
  if (!tiles.length) return null;
  const cols = tiles.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : tiles.length === 2 ? 'grid-cols-2' : 'grid-cols-1';
  return (
    <div className={`mt-3 grid gap-3 ${cols}`} data-testid="money-strip">
      {tiles.map((t) => (
        <Card key={t.key} className="p-4">
          <div className="flex items-center justify-between gap-2">
            <MonoLabel>{t.label}</MonoLabel>
            {t.chip && <Chip />}
          </div>
          <div className={`mt-1 flex items-center gap-2 text-h3 ${t.tone === 'critical' ? 'text-critical' : t.tone === 'success' ? 'text-success' : ''}`}>
            {t.tone === 'critical' && <AlertTriangle size={18} aria-label="needs attention" />}
            {t.tone === 'success' && <Check size={18} aria-label="good" />}
            <span>{t.value}{t.per ? <span className="text-small text-neutral-900">{t.per}</span> : null}</span>
          </div>
          {t.sub && <div className="mt-0.5 text-tiny text-neutral-900">{t.sub}</div>}
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- this week
// One card, the weekly story (spec §2.3): last check, what was applied and
// how it is doing, next check. Tapping opens History.
function ThisWeek({ week, access, money }) {
  if (!week) return null;
  const active = access && access.level === 'active';
  let line;
  let projection = null;
  if (!week.last_check_at) {
    line = 'Your first check is running now. Each week\'s story lands here: what we found, what was fixed, and whether it held.';
  } else {
    const head = `Checked ${whenChecked(week.last_check_at)}${week.findings != null ? `, ${plural(week.findings, 'finding', 'findings')}` : ''}.`;
    let middle;
    if (active) {
      if (week.applied > 0) {
        const parts = [];
        if (week.verified) parts.push(`${week.verified} verified working`);
        if (week.watching) parts.push(`${week.watching} still being watched`);
        if (week.reverted) parts.push(`${week.reverted} put back, we told you`);
        middle = `${plural(week.applied, 'fix applied', 'fixes applied')}${parts.length ? `, ${parts.join(', ')}` : ''}.`;
      } else {
        middle = 'No fixes applied this week.';
      }
    } else {
      middle = access && access.pending_count > 0
        ? `${plural(access.pending_count, 'fix drafted', 'fixes drafted')}, waiting for your yes.`
        : 'Nothing waiting for your yes right now.';
      if (access && access.pending_count > 0 && access.pending_value_usd > 0 && money) projection = `about ${money(access.pending_value_usd)} a month`;
    }
    line = `${head} ${middle} ${nextCheck(week.next_check_days)}`;
  }
  return (
    <Link to="/app/ledger" className="block">
      <Card className="lift mt-3 flex items-center justify-between gap-3 p-5">
        <div>
          <MonoLabel>This week</MonoLabel>
          <p className="mt-1 text-body">{line}</p>
          {projection && <p className="mt-1 flex items-center gap-2 text-small text-neutral-900">{projection} <Chip /></p>}
        </div>
        <ArrowRight size={16} className="shrink-0 text-neutral-900" aria-hidden />
      </Card>
    </Link>
  );
}

// ---------------------------------------------------------------- performance
// One chart (spec §2.5), only once seven days of numbers exist; before that
// the card says what will fill it, never an empty chart.
function Performance({ performance, money }) {
  // The chart draws at the card's real width so its labels stay legible on a
  // phone instead of being scaled down from a desktop canvas.
  const box = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') { if (el) setW(el.clientWidth); return undefined; }
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, [performance]);
  if (!performance) return null;
  const days = performance.days || [];
  return (
    <div className="mt-8">
      <h2 className="text-h4">Performance, 28 days</h2>
      <Card className="mt-3 p-4 sm:p-5">
        {days.length >= 7 ? (
          <>
            <div ref={box}>
              {w > 0 && <PerformanceChart w={Math.max(300, w)} days={days} checks={performance.checks || []} fixes={performance.fixes || []} labelMoney={(n) => money(n)} />}
            </div>
            <p className="mt-2 text-tiny text-neutral-900">Dotted lines are weekly checks. Marks are fixes you approved: a circle held, a square was put back, a triangle is still being watched.</p>
          </>
        ) : (
          <p className="text-small text-neutral-900">Your daily numbers start building after the first check. The chart appears once a week of them is in.</p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- alerts
// Only when present (spec §2.7): one line each from the last 7 days,
// severity chip and time; acknowledging is a tap. Absent when there are none.
const ALERT_TONE = { critical: 'text-critical', warning: 'text-warning', info: 'text-info' };
function Alerts({ alerts, onAck }) {
  const [busy, setBusy] = useState(null);
  if (!alerts || !alerts.length) return null;
  async function ack(id) {
    setBusy(id);
    try { await api(`/api/app/alerts/${id}/ack`, { method: 'POST' }); onAck(id); } catch { /* stays listed */ }
    setBusy(null);
  }
  // "Expected, until Sunday" (fix plan move 17): a sale week is not a spike.
  const sunday = (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); return d; })();
  async function expected(id) {
    setBusy(id);
    try { await api(`/api/app/alerts/${id}/expected`, { method: 'POST', body: { until: sunday.toISOString() } }); onAck(id); } catch { /* stays listed */ }
    setBusy(null);
  }
  return (
    <div className="mt-8">
      <h2 className="text-h4">Alerts</h2>
      <Card className="mt-3 divide-y divide-neutral-200">
        {alerts.map((a) => (
          <div key={a.id} className={`flex items-center gap-3 p-4 ${a.acked ? 'opacity-60' : ''}`}>
            <AlertTriangle size={16} className={`shrink-0 ${ALERT_TONE[a.severity] || 'text-neutral-900'}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-small">{a.title}</div>
              <div className="mt-0.5 font-mono text-tiny uppercase tracking-[0.1em] text-neutral-900">
                <span className={ALERT_TONE[a.severity] || ''}>{a.severity}</span> · {ago(a.at)}
              </div>
            </div>
            {a.acked
              ? <span className="inline-flex items-center gap-1 text-tiny text-neutral-900"><Check size={13} aria-hidden /> Seen</span>
              : (
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Button variant="secondary" onClick={() => ack(a.id)} disabled={busy === a.id} className="!px-3 !py-1.5 text-tiny">Got it</Button>
                  {(a.kind === 'spend_spike' || a.kind === 'pace_over') && (
                    <button type="button" onClick={() => expected(a.id)} disabled={busy === a.id} className="text-tiny text-neutral-900 underline underline-offset-2">Expected, until Sunday</button>
                  )}
                </span>
              )}
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- your accounts
// Three compact rows (spec §2.6): status dot, name or id, last read time.
// Each row opens the matching Connected data tab; reconnect appears inline.
const DOT = { ok: 'bg-success', reconnect: 'bg-warning', unmatched: 'bg-warning', unused: 'bg-neutral-800', missing: 'bg-neutral-800' };
const UNUSED_LINE = { ga4_property: 'No analytics on your site. We can set it up with you.', gtm_container: 'You do not use Tag Manager. Plenty of good setups skip it.', ads_account: 'Not matched to your site yet.' };
function Accounts({ accounts, site }) {
  if (!accounts || !accounts.length) return null;
  return (
    <div className="mt-8">
      <h2 className="text-h4">Your accounts</h2>
      <Card className="mt-3 divide-y divide-neutral-200">
        {accounts.map((a) => (
          <div key={a.kind} className="flex items-center gap-3 p-4">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[a.status] || DOT.missing}`} />
            <div className="min-w-0 flex-1">
              <MonoLabel>{a.label}</MonoLabel>
              <div className="truncate text-body">
                {a.name ? <Link to={a.href} className="underline-offset-2 hover:underline">{a.name}</Link> : <span className="text-small text-neutral-900">{a.status === 'unused' ? UNUSED_LINE[a.kind] : 'Not matched to your site yet.'}</span>}
              </div>
            </div>
            <div className="shrink-0 text-right text-tiny text-neutral-900">
              {a.status === 'reconnect' && <a href="/auth/google/start?step=discovery" className="text-warning underline underline-offset-2">Reconnect</a>}
              {a.status === 'ok' && (a.read_at ? `read ${ago(a.read_at)}` : 'not read yet')}
              {(a.status === 'unmatched' || a.status === 'missing') && <Link to="/app/confirm" className="text-warning underline underline-offset-2">Choose it</Link>}
            </div>
          </div>
        ))}
      </Card>
      {site && (site.whatsapp || site.phone || site.consent_tool || site.server_side_gtm) && (
        <ul className="mt-2 flex flex-col gap-1 text-tiny text-neutral-900">
          {(site.whatsapp || site.phone) && <li>Customers reach you {site.whatsapp && site.phone ? 'on WhatsApp and by phone' : site.whatsapp ? 'on WhatsApp' : 'by phone'}. Counting those is the one thing that matters; we propose it when it is missing.</li>}
          {site.consent_tool && <li>Your site waits for cookie consent ({site.consent_tool}) before recording, which is right.</li>}
          {site.server_side_gtm && <li>You use server-side tagging. We read it through your analytics.</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- waiting
// Approved but not yet applied (fix plan move 5): say why, with the one tap
// that unblocks it, instead of letting it drag in silence.
function WaitingCard({ waiting, access }) {
  if (!waiting || !waiting.approved || !access) return null;
  const n = waiting.approved;
  const fixes = plural(n, 'approved fix', 'approved fixes');
  const late = waiting.oldest_at && Date.now() - Date.parse(waiting.oldest_at) > 60 * 60_000;
  if (access.fix_access === 'ask' && waiting.needs_fix_access) {
    return (
      <Card accent="warning" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-body font-semibold">One tap before we can apply {n === 1 ? 'your fix' : `your ${n} fixes`}.</div>
          <div className="mt-0.5 text-small text-neutral-900">Google will ask once for permission to change your analytics and tracking. Nothing else changes.</div>
        </div>
        <Button href={writeStepHref('/app')} className="shrink-0 !px-5 !py-2.5">Allow fixes</Button>
      </Card>
    );
  }
  if (access.fix_access === 'reconnect') {
    return (
      <Card accent="warning" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-body font-semibold">Reconnect Google to apply {fixes}.</div>
          <div className="mt-0.5 text-small text-neutral-900">Your Google connection has lapsed. One tap puts it back; your fixes apply within the hour after.</div>
        </div>
        <Button href="/auth/google/start?step=discovery" className="shrink-0 !px-5 !py-2.5">Reconnect</Button>
      </Card>
    );
  }
  if (!late) return null;
  return (
    <Card accent="info" className="mt-3 p-5">
      <div className="text-body font-semibold">{fixes.replace(/^\w/, (c) => c.toUpperCase())} taking longer than usual.</div>
      <div className="mt-0.5 text-small text-neutral-900">We are on it. History will say what happened either way.</div>
    </Card>
  );
}

// ---------------------------------------------------------------- needs you
// The total value line under "Waiting for your yes" (spec §2.4) and, at
// active, the batch yes for the safe categories when two or more are waiting.
function NeedsYouHead({ pending, access, money }) {
  const batch = useBatchApprove();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [armed, setArmed] = useState(false);
  if (!pending || !pending.length || !access) return null;
  const active = access.level === 'active';
  const safe = safeFixes(pending);
  const value = access.pending_value_usd > 0 ? `about ${money(access.pending_value_usd)} a month` : null;
  // A batch yes is confirmed once (QA-005): the first tap arms it, the second approves.
  async function all() {
    if (!armed) { setArmed(true); return; }
    setBusy(true); setNote(null); setArmed(false);
    try { await batch(safe, `${plural(safe.length, 'safe fix', 'safe fixes')}`); } catch (e) { setNote(e.message); }
    setBusy(false);
  }
  return (
    <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-center gap-2 text-small text-neutral-900">
        {plural(pending.length, 'fix', 'fixes')}{value ? `, ${value}` : ''}
        {!active && value && <Chip />}
      </p>
      {active && safe.length >= 2 && access.role !== 'viewer' && (
        <span className="flex flex-wrap items-center gap-2">
          <Button variant={armed ? 'primary' : 'secondary'} onClick={all} disabled={busy} className="!px-4 !py-2">
            {busy ? 'Approving…' : armed ? `Yes, approve all ${safe.length}` : `Approve all ${safe.length} safe fixes`}
          </Button>
          {armed && <button type="button" onClick={() => setArmed(false)} className="text-small underline underline-offset-2">Not yet</button>}
          {armed && <span className="basis-full text-tiny text-neutral-900">Applied within the hour, watched for 48 hours, each one undoable in History.</span>}
        </span>
      )}
      {note && <span className="text-tiny text-critical">{note}</span>}
    </div>
  );
}

// Gated states (gated-platform spec §4, Home). Locked: the $20 is the next
// step and it is said in their numbers. Unlocked: the projection of what a
// plan does with the fixes already queued, and the door to it.
function NextStep({ access, pending, latest, money, goUnlock, openSheet }) {
  if (!access || !latest) return null;
  // An empty report is never charged for (fix plan move 8).
  if (access.level === 'locked' && access.findings_count === 0 && pending.length === 0) {
    return (
      <Card accent="success" className="mt-3 p-5">
        <div className="text-body font-semibold">Nothing to fix right now.</div>
        <div className="mt-0.5 text-small text-neutral-900">We keep checking every week and tell you the moment something breaks. No charge for an empty report.</div>
      </Card>
    );
  }
  if (access.level === 'locked') {
    return (
      <Card accent="warning" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Lock size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <div>
            <div className="text-body font-semibold">
              {access.waste_monthly_usd > 0 ? `About ${money(access.waste_monthly_usd)} a month is going to waste.` : 'Your report is ready.'}
            </div>
            <div className="mt-0.5 text-small text-neutral-900">
              {pending.length > 0 ? `${pending.length} fix${pending.length === 1 ? '' : 'es'} ${pending.length === 1 ? 'is' : 'are'} drafted. ` : ''}Every line, every fix and every verdict opens with the full report.
            </div>
          </div>
        </div>
        <Button onClick={goUnlock} className="shrink-0 !px-5 !py-2.5">Unlock the full report, $20</Button>
      </Card>
    );
  }
  if (access.level === 'unlocked' && pending.length > 0) {
    return (
      <Card accent="success" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Zap size={17} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <div>
            <div className="text-body font-semibold">
              If you approve all {pending.length}{access.pending_value_usd > 0 ? `: about ${money(access.pending_value_usd)} a month recovered` : ' fixes, they are applied within the hour'}.
            </div>
            <div className="mt-0.5 text-small text-neutral-900">
              A plan applies what you approve, checks again every week, and keeps a one-tap undo on everything. {access.credit_applies ? `Your $${access.credit_usd || 20} comes off the first month.` : ''}
            </div>
          </div>
        </div>
        <Button onClick={() => openSheet({ title: 'Start fixing' })} className="shrink-0 !px-5 !py-2.5">Start fixing</Button>
      </Card>
    );
  }
  return null;
}

export default function Home() {
  const [data, setData] = useState(null);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const { access, goUnlock, openSheet, money: accessMoney, version } = useAccess();
  useEffect(() => { api('/api/app/home').then(setData).catch((e) => setError(e.message)); }, [version]);
  // The overview rides separately so an older server (or a hiccup) never
  // takes the whole screen down: the new sections simply wait.
  useEffect(() => { api('/api/app/overview').then((d) => setOverview(d.overview || null)).catch(() => setOverview(null)); }, [version]);

  if (error) return <div className="mx-auto max-w-m2 px-5 pt-14"><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Loading your account" />;

  const { health, pending, reports, streak, plan } = data;
  const code = data.currency || 'USD';
  const money = (n) => (code === 'USD' ? `$${Math.round(n).toLocaleString()}` : `${code} ${Math.round(n).toLocaleString()}`);
  const latest = reports && reports[0];
  // The first check, with a date on it (fix plan move 8): running, late, or failed.
  const firstCheckLine = (() => {
    if (overview && overview.failed_last && !overview.running) return 'The check did not finish, our side. We are on it; you will get the email when it lands.';
    if (overview && overview.running && overview.running.since) {
      const mins = (Date.now() - Date.parse(overview.running.since)) / 60_000;
      if (mins > 20) {
        const until = new Date(Date.parse(overview.running.since) + 40 * 60_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `Taking longer than usual. Give it until ${until}; if nothing lands, run it again from Settings.`;
      }
    }
    return 'We are reading your Google Ads, Analytics and tracking from the inside. Your report lands here in about ten minutes, and in your inbox.';
  })();
  const trend = (health.trend || []).map((p) => (typeof p === 'number' ? p : p.score));
  const delta = trend.length >= 2 ? trend[trend.length - 1] - trend[trend.length - 2] : null;
  const showGraduation = (streak || 0) >= 10 && plan && plan.tier === 'core';

  return (
    <div className="mx-auto max-w-m2 px-5 pb-24 pt-10">
      {overview && overview.notice && (
        <Card accent="info" className="mb-3 p-4 text-small">{overview.notice}</Card>
      )}
      {access && access.managed && (
        <Card className="mb-3 p-4 text-small">
          Looked after by <strong>{access.managed.agency}</strong>. {access.managed.mode === 'read_only'
            ? 'They approve fixes and undo changes for you; everything here is yours to read.'
            : 'They see what you see and can approve fixes; anything you approve here is logged for them too.'}
        </Card>
      )}
      {overview && overview.held_report && (
        <Card accent="info" className="mb-3 p-4 text-small">
          Your agency is reviewing this week&apos;s check. The report lands here once they have looked at it.
        </Card>
      )}
      <Card className="flex items-center gap-5 p-5">
        {latest ? <MiniDial score={health.score} /> : (
          <div className="flex h-[100px] w-[100px] shrink-0 items-center justify-center" aria-hidden>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-400 border-t-(--ui-cta-a)" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <MonoLabel>Account health</MonoLabel>
          <div className="mt-0.5 text-h5">
            {!latest ? 'Your first check is running.' : health.score < 50 ? 'Needs work - fixes waiting below.' : health.score < 70 ? 'Getting better every week.' : 'Healthy - we keep watch.'}
          </div>
          {!latest && <p className="mt-1 text-small text-neutral-900">{firstCheckLine}</p>}
          {latest && overview && overview.spend === null && overview.this_week && overview.this_week.findings === 0 && (
            <p className="mt-1 text-small text-neutral-900">Nothing is running. Switch a campaign on and the first check runs the next morning.</p>
          )}
          {overview && overview.cadence === 'monthly' && access && access.level !== 'active' && (
            <p className="mt-1 text-small text-neutral-900">Checks are monthly until you start a plan.{access.credit_applies ? ` Your $${access.credit_usd || 20} comes off the first month.` : ''}</p>
          )}
          {access && access.paused_until && (
            <p className="mt-1 text-small text-neutral-900">Paused until {new Date(access.paused_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. Alerts about breakage still reach you.</p>
          )}
          {latest && (
            <Link to={`/app/report/${latest.id}`} className="mt-1 inline-flex items-center gap-1 text-small underline underline-offset-2">
              Latest report <ArrowRight size={13} aria-hidden />
            </Link>
          )}
        </div>
        {trend.length >= 2 && (
          <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
            <Sparkline points={trend} />
            {delta !== null && delta !== 0 && (
              <span className={`font-mono text-tiny ${delta > 0 ? 'text-success' : 'text-critical'}`}>
                {delta > 0 ? '+' : ''}{delta} since last report
              </span>
            )}
          </div>
        )}
      </Card>

      <NextStep access={access} pending={pending} latest={latest} money={accessMoney} goUnlock={goUnlock} openSheet={openSheet} />
      {overview && <WaitingCard waiting={overview.waiting} access={access} />}

      {showGraduation && (
        <Card accent="info" className="mt-3 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Zap size={17} className="mt-0.5 shrink-0 text-info" aria-hidden />
            <div>
              <div className="text-body font-semibold">You&apos;ve said yes {streak} times in a row.</div>
              <div className="mt-0.5 text-small text-neutral-900">
                Autopilot applies these same safe fixes for you and tells you after - you keep the one-tap undo on every change.
              </div>
            </div>
          </div>
          <Button variant="secondary" onClick={() => openSheet({ mode: 'upgrade' })} className="shrink-0 !px-4 !py-2">See Autopilot</Button>
        </Card>
      )}

      {overview && <MoneyStrip overview={overview} access={access} money={accessMoney} />}
      {overview && <ThisWeek week={overview.this_week} access={access} money={accessMoney} />}

      {plan && plan.tier && (
        <div className="mt-3 flex items-center justify-between rounded border border-neutral-300 bg-neutral-50 px-4 py-2.5 text-small text-neutral-900">
          <span>
            {plan.label} plan · sized for accounts around {plan.band === '25k' ? '25,000' : plan.band === '10k' ? '10,000' : '4,000'} search terms
          </span>
          <Link to="/app/settings" className="underline underline-offset-2">Manage</Link>
        </div>
      )}

      <div className="mt-8">
        <div className="flex items-end justify-between">
          <h2 className="text-h4">Waiting for your yes</h2>
          {pending.length > 0 && <Link to="/app/approvals" className="text-small underline underline-offset-2">See all</Link>}
        </div>
        <NeedsYouHead pending={pending} access={access} money={accessMoney} />
        {pending.length === 0 ? (
          <div className="mt-3">
            <EmptyState title={latest ? 'Nothing waiting' : 'Your first check is on its way'} body={latest ? 'Your next weekly check will bring anything worth fixing straight here.' : 'Anything worth fixing will appear here the moment the first check finishes.'} />
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {pending.slice(0, 3).map((p, i) => (
              <Card key={p.id} className="rise lift flex items-center justify-between gap-3 p-4" style={{ '--rise-i': i }}>
                <div>
                  <div className="text-body font-medium">{p.title}</div>
                  {p.money_line && access && access.level !== 'locked' && <div className="mt-0.5 text-small text-neutral-900">{p.money_line}</div>}
                </div>
                <Link to="/app/approvals"><Button variant="secondary" className="!px-4 !py-2">Review</Button></Link>
              </Card>
            ))}
          </div>
        )}
      </div>

      {overview && <Performance performance={overview.performance} money={accessMoney} />}
      {overview && <Accounts accounts={overview.accounts} site={overview.site} />}
      {overview && <Alerts alerts={overview.alerts} onAck={(id) => setOverview((o) => (o ? { ...o, alerts: o.alerts.map((a) => (a.id === id ? { ...a, acked: true } : a)) } : o))} />}
    </div>
  );
}
