-- Insyt schema · build-doc §1.7–1.9 · journeys, watches, autopilot, benchmarks, metering

-- ---------------------------------------------------------------- journey_state
create table journey_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  journey text not null check (journey in ('A','B','C')),
  stage text not null,
  gates jsonb not null default '{"tag":false,"billing":false,"approval":false}',
  tag_install jsonb not null default '{}',
  resume_token text unique,
  updated_at timestamptz not null default now()
);
create index journey_tenant_idx on journey_state(tenant_id);

-- ---------------------------------------------------------------- watches
create table watches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('tag_alive','changeset_verify','first_conversion','first_click')),
  target_id uuid,
  schedule jsonb not null default '{}', -- cron/backoff state
  baseline jsonb not null default '{}', -- 28-day day-of-week expected values
  status text not null default 'active' check (status in ('active','triggered','resolved','disabled')),
  last_check_at timestamptz,
  triggered_at timestamptz,
  created_at timestamptz not null default now()
);
create index watches_tenant_idx on watches(tenant_id);
create index watches_due_idx on watches(status, last_check_at) where status = 'active';

-- ---------------------------------------------------------------- autopilot_settings
create table autopilot_settings (
  tenant_id uuid primary key references tenants(id),
  categories jsonb not null default '{"negatives":"manual","bids":"manual","budgets":"manual","gtm_publish":"manual"}',
  graduated_at timestamptz,
  consecutive_approvals int not null default 0
);

-- ---------------------------------------------------------------- benchmark_events (anonymised at write; no tenant FK by design)
create table benchmark_events (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,
  geo text not null,
  metric text not null check (metric in ('cpc','ctr','cvr','waste_pct')),
  value numeric(12,4) not null,
  spend_band text not null check (spend_band in ('4k','10k','25k')),
  observed_month date not null
);
create index benchmark_lookup_idx on benchmark_events(vertical, geo, spend_band, metric, observed_month);

-- ---------------------------------------------------------------- token_metering
create table token_metering (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid references runs(id),
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);
create index metering_tenant_idx on token_metering(tenant_id, created_at);

-- ---------------------------------------------------------------- RLS
alter table journey_state enable row level security;
alter table watches enable row level security;
alter table autopilot_settings enable row level security;
alter table benchmark_events enable row level security;
alter table token_metering enable row level security;

create policy journey_self_read on journey_state for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy autopilot_self_read on autopilot_settings for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
-- watches, benchmark_events, token_metering: service role only.
