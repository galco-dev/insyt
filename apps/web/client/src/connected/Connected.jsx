// Connected data - what Insyt reads through each Google permission, shown as
// the raw objects Google returns for THIS account, in Google's own names.
// This screen is deliberately in the technical register (container, property,
// conversion action) so a customer, or a reviewer, can see exactly what each
// granted scope gives us. Everything else in the app stays in plain words.
//
// Tabs:  Google Ads (adwords)  ·  Google Analytics (analytics.readonly)  ·
//        Tag Manager (tagmanager.readonly)
// Ads actions (pause a campaign, exclude searches) are approved changes: the
// worker applies them within a minute, History shows them with Undo.
import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Download01 as Download, RefreshCw01 as Refresh, PauseCircle, MinusCircle, CheckCircle, Clock } from '@untitledui/icons';
import { api } from '../lib/api.js';
import { Link } from '../lib/router.jsx';
import { MonoLabel, Card, Spinner, Button, ErrorNote, Segments, Pill } from '../lib/ui.jsx';

const TABS = [
  { key: 'ads', label: 'Google Ads', to: '/app/connected' },
  { key: 'ga4', label: 'Google Analytics', to: '/app/connected/analytics' },
  { key: 'gtm', label: 'Tag Manager', to: '/app/connected/tag-manager' },
];

const money = (n, cur) => `${cur ? `${cur} ` : ''}${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const int = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function Table({ cols, rows, empty = 'Nothing returned.', keyOf, rowExtra }) {
  if (!rows || !rows.length) return <p className="px-4 py-6 text-small text-neutral-900">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-small">
        <thead>
          <tr className="border-b border-neutral-300">
            {cols.map((c) => (
              <th key={c.key} className={clsx('px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-800', c.num && 'text-right')}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const k = keyOf ? keyOf(r, i) : i;
            const extra = rowExtra ? rowExtra(r) : null;
            return (
              <React.Fragment key={k}>
                <tr className="border-b border-neutral-200 last:border-0">
                  {cols.map((c) => (
                    <td key={c.key} className={clsx('px-4 py-2.5 align-top', c.num && 'text-right font-mono tabular-nums', c.mono && 'font-mono text-tiny')}>
                      {c.render ? c.render(r) : r[c.key]}
                    </td>
                  ))}
                </tr>
                {extra && (
                  <tr className="border-b border-neutral-200 last:border-0">
                    <td colSpan={cols.length} className="p-0">{extra}</td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KV({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
      {items.filter((x) => x[1] != null && x[1] !== '').map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 border-b border-neutral-200 py-1.5 text-small">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-800">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Head({ api: apiName, scope, fetchedAt, onRefresh, busy }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <MonoLabel>Read through</MonoLabel>
        <div className="mt-0.5 text-body font-medium">{apiName}</div>
        <div className="mt-0.5 font-mono text-tiny text-neutral-900">{scope}</div>
      </div>
      <div className="flex items-center gap-3">
        {fetchedAt && <span className="font-mono text-tiny text-neutral-900">fetched {when(fetchedAt)}</span>}
        <Button variant="secondary" onClick={onRefresh} disabled={busy} className="!px-3 !py-1.5">
          <Refresh size={14} aria-hidden /> Refresh
        </Button>
      </div>
    </div>
  );
}

function useTab(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError(null);
    try { setData(await api(path)); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  useEffect(() => { load(); }, [path]);
  return { data, error, busy, reload: load };
}

// Action feedback: approvals read as confirmations, everything else as a warning.
function Note({ text }) {
  if (!text) return null;
  if (!/^Approved:/.test(text)) return <ErrorNote message={text} />;
  return (
    <div className="flex items-start gap-2 rounded bg-success-tint p-4 text-small text-strong ring-1 ring-inset ring-success/25">
      <CheckCircle size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

function NotLinked({ reason }) {
  return (
    <Card className="p-6">
      <p className="text-small text-neutral-900">{reason}</p>
      <div className="mt-4"><Link to="/app/settings"><Button variant="secondary">Back to Settings</Button></Link></div>
    </Card>
  );
}

/* ------------------------------------------------------------------ Ads */
const CHANGE_STATE = {
  proposed: ['Waiting for approval', Clock], approved: ['Approved, applying within a minute', Clock],
  applied: ['Applied', CheckCircle], reverted: ['Undone', MinusCircle], failed: ['Did not apply', MinusCircle],
};

function AdsTab() {
  const { data, error, busy, reload } = useTab('/api/app/connected/ads');
  const [acting, setActing] = useState(null);
  const [note, setNote] = useState(null);
  const [negFor, setNegFor] = useState(null);
  const [negText, setNegText] = useState('');

  // Poll while an action is in flight so the row flips to Applied on its own.
  useEffect(() => {
    if (!data || !data.changes || !data.changes.some((c) => c.status === 'approved' || c.status === 'proposed')) return undefined;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [data]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner label="Reading your Google Ads account" />;
  if (!data.linked || data.reason) return <NotLinked reason={data.reason} />;

  const cur = data.account.currency_code;

  async function pause(c) {
    setActing(c.id); setNote(null);
    try {
      const r = await api(`/api/app/connected/ads/campaigns/${c.id}/pause`, { method: 'POST' });
      setNote(`Approved: pause "${c.name}". Insyt applies it within a minute; History will show it with Undo.`);
      await reload();
      return r;
    } catch (e) { setNote(e.message); }
    finally { setActing(null); }
    return null;
  }
  async function exclude(c) {
    const terms = negText.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
    if (!terms.length) { setNote('Type at least one search to exclude.'); return; }
    setActing(c.id); setNote(null);
    try {
      await api(`/api/app/connected/ads/campaigns/${c.id}/negatives`, { method: 'POST', body: { terms } });
      setNote(`Approved: exclude ${terms.length} search${terms.length === 1 ? '' : 'es'} from "${c.name}" as exact-match negative keywords. Applies within a minute; Undo removes them.`);
      setNegFor(null); setNegText('');
      await reload();
    } catch (e) { setNote(e.message); }
    finally { setActing(null); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Head api={data.api} scope={data.scope} fetchedAt={data.fetched_at} onRefresh={reload} busy={busy} />

      <Card className="p-5">
        <MonoLabel>Customer (account)</MonoLabel>
        <div className="mt-2">
          <KV items={[
            ['Customer ID', <span className="font-mono">{data.account.customer_id_display}</span>],
            ['Descriptive name', data.account.name],
            ['Currency', data.account.currency_code],
            ['Time zone', data.account.time_zone],
            ['Status', data.account.status],
            ['Cost, last 30 days', money(data.account.spend_30d, cur)],
            ['Cost, last 90 days', money(data.account.spend_90d, cur)],
            ['Conversions, last 30 days', int(data.account.conversions_30d)],
          ]} />
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between px-4 pt-4">
          <div>
            <MonoLabel>Campaigns</MonoLabel>
            <p className="mt-0.5 text-tiny text-neutral-900">campaign, campaign_budget and metrics resources, last 30 days. Pause and Exclude are writes to this account; both wait for the worker and both can be undone from History.</p>
          </div>
        </div>
        <div className="mt-3">
          <Table
            keyOf={(r) => r.id}
            cols={[
              { key: 'name', label: 'Campaign', render: (r) => (
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-tiny text-neutral-900">id {r.id}{r.ad_groups.length ? ` · ${r.ad_groups.length} ad group${r.ad_groups.length === 1 ? '' : 's'}` : ''}</div>
                </div>
              ) },
              { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'enabled' ? 'success' : 'neutral'}>{r.pause_pending ? 'pausing' : r.status}</Pill> },
              { key: 'bidding', label: 'Bidding', mono: true, render: (r) => `${r.bidding.strategy || ''}${r.bidding.target != null ? ` · ${r.bidding.target}` : ''}` },
              { key: 'budget_daily', label: 'Budget / day', num: true, render: (r) => money(r.budget_daily, cur) },
              { key: 'spend_30d', label: 'Cost 30d', num: true, render: (r) => money(r.spend_30d, cur) },
              { key: 'conversions_30d', label: 'Conv. 30d', num: true, render: (r) => int(r.conversions_30d) },
              { key: 'actions', label: '', render: (r) => (
                <div className="flex flex-col items-end gap-1.5">
                  <Button variant="secondary" className="!px-3 !py-1.5 whitespace-nowrap" disabled={acting === r.id || r.status !== 'enabled' || r.pause_pending} onClick={() => pause(r)}>
                    <PauseCircle size={14} aria-hidden /> Pause
                  </Button>
                  <Button variant="secondary" className="!px-3 !py-1.5 whitespace-nowrap" disabled={acting === r.id} onClick={() => { setNegFor(negFor === r.id ? null : r.id); setNegText(''); }}>
                    <MinusCircle size={14} aria-hidden /> Exclude searches
                  </Button>
                </div>
              ) },
            ]}
            rows={data.campaigns}
            empty="No campaigns were returned for this account."
            rowExtra={(c) => (negFor === c.id ? (
              <div className="bg-(--ui-well) p-4">
                <MonoLabel>Exclude searches from "{c.name}"</MonoLabel>
                <p className="mt-0.5 text-tiny text-neutral-900">One per line or comma-separated. Added as exact-match negative keywords on the campaign (campaign_criterion resources). Up to 25 at a time.</p>
                <textarea
                  value={negText}
                  onChange={(e) => setNegText(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="free course, jobs near me"
                  className="mt-2 w-full rounded bg-page p-3 font-mono text-small text-strong ring-1 ring-inset ring-(--ui-ring) focus:outline-none focus:ring-(--ui-focus)"
                />
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => exclude(c)} disabled={acting === c.id}>Approve and exclude</Button>
                  <Button variant="secondary" onClick={() => setNegFor(null)}>Cancel</Button>
                </div>
              </div>
            ) : null)}
          />
        </div>
      </Card>

      <Note text={note} />

      {data.changes && data.changes.length > 0 && (
        <Card>
          <div className="px-4 pt-4"><MonoLabel>Changes made from this screen</MonoLabel></div>
          <div className="mt-2">
            <Table
              keyOf={(r) => r.id}
              cols={[
                { key: 'summary_text', label: 'Change' },
                { key: 'tool_id', label: 'Tool', mono: true },
                { key: 'status', label: 'State', render: (r) => { const [label, IconEl] = CHANGE_STATE[r.status] || [r.status, Clock]; return <span className="inline-flex items-center gap-1.5"><IconEl size={14} aria-hidden /> {label}</span>; } },
                { key: 'created_at', label: 'When', mono: true, render: (r) => when(r.applied_at || r.created_at) },
                { key: 'undo', label: '', render: (r) => (r.status === 'applied' ? <Link to="/app/ledger" className="text-small underline underline-offset-4">Undo in History</Link> : null) },
              ]}
              rows={data.changes}
            />
          </div>
        </Card>
      )}

      <Card>
        <div className="px-4 pt-4">
          <MonoLabel>Conversion actions</MonoLabel>
          <p className="mt-0.5 text-tiny text-neutral-900">conversion_action resources with status ENABLED, and their 30-day counts.</p>
        </div>
        <div className="mt-2">
          <Table
            keyOf={(r) => r.id}
            cols={[
              { key: 'name', label: 'Name' },
              { key: 'primary', label: 'Goal', render: (r) => (r.primary ? 'primary' : 'secondary') },
              { key: 'source', label: 'Source', mono: true },
              { key: 'category', label: 'Category', mono: true },
              { key: 'count_30d', label: 'Conv. 30d', num: true, render: (r) => int(r.count_30d) },
            ]}
            rows={data.conversion_actions}
            empty="No enabled conversion actions were returned."
          />
        </div>
      </Card>

      <Card>
        <div className="px-4 pt-4">
          <MonoLabel>Search terms</MonoLabel>
          <p className="mt-0.5 text-tiny text-neutral-900">search_term_view, last 90 days, top 50 by cost.</p>
        </div>
        <div className="mt-2">
          <Table
            keyOf={(r) => `${r.term}:${r.campaign_id}`}
            cols={[
              { key: 'term', label: 'Search term' },
              { key: 'campaign_id', label: 'Campaign', mono: true, render: (r) => (data.campaigns.find((c) => c.id === r.campaign_id) || {}).name || r.campaign_id },
              { key: 'clicks_90d', label: 'Clicks', num: true, render: (r) => int(r.clicks_90d) },
              { key: 'spend_90d', label: 'Cost', num: true, render: (r) => money(r.spend_90d, cur) },
              { key: 'conversions_90d', label: 'Conv.', num: true, render: (r) => int(r.conversions_90d) },
            ]}
            rows={data.search_terms}
            empty="No search terms in the last 90 days (no enabled search campaigns with clicks)."
          />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ GA4 */
function Ga4Tab() {
  const { data, error, busy, reload } = useTab('/api/app/connected/ga4');
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner label="Reading your Google Analytics property" />;
  if (!data.linked || data.reason) return <NotLinked reason={data.reason} />;
  const p = data.property; const r = data.report;
  return (
    <div className="flex flex-col gap-4">
      <Head api={data.api} scope={data.scope} fetchedAt={data.fetched_at} onRefresh={reload} busy={busy} />

      <Card className="p-5">
        <MonoLabel>Property</MonoLabel>
        <div className="mt-2">
          <KV items={[
            ['Property ID', <span className="font-mono">{p.id}</span>],
            ['Display name', p.name],
            ['Account', p.account],
            ['Time zone', p.time_zone],
            ['Currency', p.currency_code],
            ['Measurement IDs', p.measurement_ids && p.measurement_ids.length ? <span className="font-mono">{p.measurement_ids.join(', ')}</span> : null],
            ['Data retention', `${p.retention_months} months`],
            ['Key events', p.key_events.length ? p.key_events.map((k) => k.event_name).join(', ') : 'none'],
            ['Google Ads links', p.ads_links.length ? p.ads_links.map((l) => l.customer_id).join(', ') : 'none'],
            ['Enhanced measurement', p.enhanced_measurement.enabled ? p.enhanced_measurement.events.join(', ') : 'off'],
          ]} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div>
            <MonoLabel>Report: last {r.days} days by date</MonoLabel>
            <p className="mt-0.5 text-tiny text-neutral-900">runReport on the Analytics Data API: dimension date; metrics sessions, totalUsers, screenPageViews, eventCount, keyEvents. {r.row_count} rows.</p>
          </div>
          <a href={data.export_url} download className="inline-flex items-center gap-2 rounded px-4 py-2 text-small font-medium text-(--ui-cta-ink) bg-gradient-to-b from-(--ui-cta-a) to-(--ui-cta-b) ring-1 ring-inset ring-(--ui-cta-edge)">
            <Download size={14} aria-hidden /> Download CSV
          </a>
        </div>
        <div className="mt-3">
          <Table
            keyOf={(x) => x.date}
            cols={[
              { key: 'date', label: 'Date', mono: true },
              { key: 'sessions', label: 'Sessions', num: true, render: (x) => int(x.sessions) },
              { key: 'users', label: 'Users', num: true, render: (x) => int(x.users) },
              { key: 'page_views', label: 'Page views', num: true, render: (x) => int(x.page_views) },
              { key: 'events', label: 'Events', num: true, render: (x) => int(x.events) },
              { key: 'key_events', label: 'Key events', num: true, render: (x) => int(x.key_events) },
            ]}
            rows={[...r.rows, { date: 'Total', ...r.totals }]}
            empty="The report returned no rows for this period."
          />
        </div>
      </Card>

      <Card>
        <div className="px-4 pt-4">
          <MonoLabel>Events, last {r.days} days</MonoLabel>
          <p className="mt-0.5 text-tiny text-neutral-900">runReport: dimension eventName; metrics eventCount, totalUsers. Top 25.</p>
        </div>
        <div className="mt-2">
          <Table
            keyOf={(x) => x.event_name}
            cols={[
              { key: 'event_name', label: 'Event name', mono: true },
              { key: 'count', label: 'Event count', num: true, render: (x) => int(x.count) },
              { key: 'users', label: 'Users', num: true, render: (x) => int(x.users) },
            ]}
            rows={r.events}
          />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ GTM */
function GtmTab() {
  const { data, error, busy, reload } = useTab('/api/app/connected/gtm');
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner label="Reading your Tag Manager container" />;
  if (!data.linked || data.reason) return <NotLinked reason={data.reason} />;
  return (
    <div className="flex flex-col gap-4">
      <Head api={data.api} scope={data.scope} fetchedAt={data.fetched_at} onRefresh={reload} busy={busy} />

      <Card className="p-5">
        <MonoLabel>Account → container → workspace</MonoLabel>
        <div className="mt-2">
          <KV items={[
            ['Account', `${data.account.name || ''} (${data.account.id})`],
            ['Container', `${data.container.name || ''} (${data.container.public_id})`],
            ['Container ID', <span className="font-mono">{data.container.id}</span>],
            ['Usage context', (data.container.usage_context || []).join(', ')],
            ['Workspace', `${data.workspace.name || ''} (${data.workspace.id})`],
            ['Latest version', data.versions && data.versions.latest ? `v${data.versions.latest.version_id} · ${data.versions.latest.tag_count} tags · ${when(data.versions.latest.created_at)}` : null],
            ['Previous version', data.versions && data.versions.previous ? `v${data.versions.previous.version_id} · ${data.versions.previous.tag_count} tags` : null],
            ['Publish dates', data.publish_dates.join(', ')],
          ]} />
        </div>
      </Card>

      <Card>
        <div className="px-4 pt-4"><MonoLabel>Tags ({data.tags.length})</MonoLabel></div>
        <div className="mt-2">
          <Table
            keyOf={(t) => t.id}
            cols={[
              { key: 'name', label: 'Tag', render: (t) => <div><div className="font-medium">{t.name}</div><div className="font-mono text-tiny text-neutral-900">id {t.id}</div></div> },
              { key: 'type', label: 'Type', mono: true },
              { key: 'measurement_id', label: 'Measurement ID / event', mono: true, render: (t) => [t.measurement_id, t.event_name].filter(Boolean).join(' · ') },
              { key: 'triggers', label: 'Firing triggers', render: (t) => t.triggers.join(', ') },
              { key: 'paused', label: 'State', render: (t) => <Pill tone={t.paused ? 'warning' : 'success'}>{t.paused ? 'paused' : 'active'}</Pill> },
            ]}
            rows={data.tags}
            empty="No tags in the workspace."
          />
        </div>
      </Card>

      <Card>
        <div className="px-4 pt-4"><MonoLabel>Triggers ({data.triggers.length})</MonoLabel></div>
        <div className="mt-2">
          <Table keyOf={(t) => t.id} cols={[{ key: 'name', label: 'Trigger' }, { key: 'type', label: 'Type', mono: true }, { key: 'id', label: 'ID', mono: true }]} rows={data.triggers} empty="No triggers in the workspace." />
        </div>
      </Card>

      <Card>
        <div className="px-4 pt-4">
          <MonoLabel>Variables ({data.variables.length} user-defined · {data.built_in_variables.length} built-in)</MonoLabel>
        </div>
        <div className="mt-2">
          <Table
            keyOf={(v, i) => `${v.id || 'b'}:${v.name}:${i}`}
            cols={[{ key: 'name', label: 'Variable' }, { key: 'type', label: 'Type', mono: true }, { key: 'id', label: 'ID', mono: true, render: (v) => v.id || 'built-in' }]}
            rows={[...data.variables, ...data.built_in_variables]}
            empty="No variables in the workspace."
          />
        </div>
      </Card>
    </div>
  );
}

export default function Connected({ tab = 'ads' }) {
  return (
    <div className="mx-auto max-w-l2 px-5 pb-24 pt-10">
      <MonoLabel>Your Google connection</MonoLabel>
      <h1 className="mt-1 text-h2 tracking-tight">Connected data</h1>
      <p className="mt-2 max-w-m2 text-small text-neutral-900">
        Exactly what Insyt reads through each permission you granted, as Google returns it. Reads are live. The two Google Ads actions on this page are written to your account only after you approve them here, and every one can be undone from History.
      </p>
      <div className="mt-4">
        <Segments items={TABS.map((t) => ({ label: t.label, to: t.to, active: t.key === tab }))} />
      </div>
      <div className="mt-5">
        {tab === 'ads' && <AdsTab />}
        {tab === 'ga4' && <Ga4Tab />}
        {tab === 'gtm' && <GtmTab />}
      </div>
    </div>
  );
}
