-- Insyt schema · build-doc §1.4–1.6 · ledger, audit log, reports, emails, billing

-- ---------------------------------------------------------------- ledger (immutable, customer-facing)
create table ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  event text not null check (event in (
    'fix_applied','fix_reverted','campaign_launched','report_sent',
    'connection_changed','subscription_changed','tag_verified','watch_triggered'
  )),
  change_id uuid references changes(id),
  actor text not null, -- 'system' or a user uuid as text
  summary_text text not null,
  money_impact_usd numeric(10,2),
  created_at timestamptz not null default now()
);
create index ledger_tenant_idx on ledger(tenant_id, created_at);

-- Immutability: no update/delete, enforced at the database.
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'this table is append-only';
end $$;
create trigger ledger_no_update before update or delete on ledger
  for each row execute function forbid_mutation();

-- Cumulative counters are views over the ledger (build §1.4).
create view ledger_cumulative as
  select tenant_id,
         count(*) filter (where event = 'fix_applied') as fixes_applied,
         coalesce(sum(money_impact_usd) filter (where event = 'fix_applied'), 0) as waste_removed_usd
  from ledger group by tenant_id;

-- ---------------------------------------------------------------- audit_log (internal superset)
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  event text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log(tenant_id, created_at);
create trigger audit_no_update before update or delete on audit_log
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------- reports
create table reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  tenant_id uuid not null references tenants(id),
  type text not null check (type in ('signup','weekly','deep','monthly_pulse')),
  html_email text,
  html_web text,
  findings_snapshot jsonb not null default '[]', -- frozen at render; reports never mutate
  unlocked boolean not null default false,
  unlocked_at timestamptz,
  viewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index reports_tenant_idx on reports(tenant_id, created_at);

-- ---------------------------------------------------------------- emails
create table emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  report_id uuid references reports(id),
  template_id text not null,
  to_email text not null,
  stream text not null check (stream in ('transactional','report')),
  status text not null default 'queued' check (status in ('queued','sent','delivered','bounced','opened')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index emails_tenant_idx on emails(tenant_id);

-- ---------------------------------------------------------------- billing
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  stripe_customer_id text not null,
  stripe_subscription_id text unique not null,
  tier text not null check (tier in ('core','autopilot','scale')),
  size_band text not null check (size_band in ('4k','10k','25k')),
  price_usd numeric(8,2) not null,
  status text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);
create index subscriptions_tenant_idx on subscriptions(tenant_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('audit_unlock','large_audit','setup_bundle')),
  stripe_payment_intent text unique not null,
  amount_usd numeric(8,2) not null,
  credited_to_subscription boolean not null default false,
  created_at timestamptz not null default now()
);
create index payments_tenant_idx on payments(tenant_id);

-- The §12 matrix as data, never code.
create table pricing_config (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null default now(),
  matrix jsonb not null,
  audit_fees jsonb not null,
  bundle_usd numeric(8,2) not null
);

-- Seed: master-doc §12 launch matrix.
insert into pricing_config (matrix, audit_fees, bundle_usd) values (
  '{"core":{"4k":129,"10k":179,"25k":249},"autopilot":{"4k":199,"10k":279,"25k":389},"scale":{"4k":399,"10k":499,"25k":649},"annual_months_free":2}',
  '{"standard":20,"large":[49,79]}',
  199
);

-- ---------------------------------------------------------------- RLS
alter table ledger enable row level security;
alter table audit_log enable row level security;
alter table reports enable row level security;
alter table emails enable row level security;
alter table subscriptions enable row level security;
alter table payments enable row level security;
alter table pricing_config enable row level security;

create policy ledger_self_read on ledger for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy reports_self_read on reports for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy subscriptions_self_read on subscriptions for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy payments_self_read on payments for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy pricing_public_read on pricing_config for select using (true);
-- audit_log, emails: service role only.
