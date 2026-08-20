-- Agency P0s (specialist audit): budget pacing, alert stream, triage snooze,
-- per-account performance targets. Targets are the AGENCY'S OWN operating
-- targets for the work (CPA/ROAS/monthly budget) — never client fees; the
-- binding no-client-billing rule holds (no fee field exists here or ever).

-- What the agency aims for on each managed account. One row per tenant,
-- updated in place; every write is audit-logged with the acting seat.
create table account_targets (
  tenant_id uuid primary key references tenants(id),
  monthly_budget_usd numeric(12,2),      -- media budget the account should pace to
  cpa_target_usd numeric(10,2),          -- null = not steering by CPA
  roas_target numeric(6,2),              -- e.g. 4.00 = 400%; null = not steering by ROAS
  set_by uuid references agency_seats(id),
  updated_at timestamptz not null default now()
);

-- Daily spend/conversion snapshots, refreshed by audit runs and the poller.
-- Pacing math reads month-to-date sums from here — no live Google calls.
create table spend_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  date date not null,
  spend_usd numeric(12,2) not null default 0,
  conversions numeric(12,2) not null default 0,
  conversion_value_usd numeric(14,2) not null default 0,
  unique(tenant_id, date)
);
create index spend_daily_tenant_date_idx on spend_daily(tenant_id, date desc);

-- Alert stream: things that broke or moved fast enough to not wait for the
-- weekly run (tag down, spend spike, disapprovals, conversion flatline).
-- Acking is per-alert, logged; the daily digest email renders from this table.
create table alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  severity text not null check (severity in ('critical','warning','info')),
  kind text not null,                    -- e.g. spend_spike | tag_down | disapproval | conv_flatline | pace_over
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  campaign_ref text,                     -- google_campaign_id when campaign-scoped
  created_at timestamptz not null default now(),
  acked_by uuid references agency_seats(id),
  acked_at timestamptz
);
create index alerts_tenant_idx on alerts(tenant_id, created_at desc);

-- Triage snooze: a change can be parked with a reason; it leaves the queue
-- until snoozed_until passes, then returns automatically. Never deleted.
alter table changes add column snoozed_until timestamptz;
alter table changes add column snoozed_by uuid references agency_seats(id);
alter table changes add column snooze_reason text;
