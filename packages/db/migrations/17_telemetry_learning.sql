-- Insyt · engine-spec §8 — learning-layer telemetry, recorded from phase 1.
-- Analysis arrives in phase 6; you cannot learn from data you did not record.
-- Everything here is backend-only (spec §11.0): nothing renders to users.
-- All tables are service-role only (RLS on, no policies) unless noted.
-- APPLIED to Supabase 27 Aug 2026 (migration telemetry_learning).

-- ---------------------------------------------------------------- watches: outcomes + effect sizes (§4.4)
alter table watches add column if not exists outcome text
  check (outcome in ('verified','inconclusive','regressed'));
alter table watches add column if not exists effect jsonb not null default '{}'::jsonb; -- measured deltas vs baseline
alter table watches add column if not exists closed_at timestamptz;

-- ---------------------------------------------------------------- events (first-party product analytics, §11.5)
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),      -- null for anonymous marketing/free-check events
  agency_id uuid references agencies(id),
  seat_id uuid references agency_seats(id),
  name text not null,                          -- e.g. screen.view | approval.approve | report.open | funnel.free_check
  props jsonb not null default '{}'::jsonb,
  source text not null default 'app' check (source in ('app','agency','server','email','marketing')),
  session_key text,
  created_at timestamptz not null default now()
);
create index if not exists events_tenant_time_idx on events(tenant_id, created_at desc);
create index if not exists events_name_time_idx on events(name, created_at desc);

-- ---------------------------------------------------------------- dismissals (§11.2 human judgment)
create table if not exists dismissals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  change_id uuid references changes(id),
  finding_id uuid references findings(id),
  rule_id text,
  reason_tap text,                             -- optional one-tap reason (wrong | not_now | did_myself | dont_touch | other)
  expanded_first boolean not null default false, -- did they open the detail before dismissing
  actor text not null default 'user',          -- user | seat:<uuid>
  created_at timestamptz not null default now()
);
create index if not exists dismissals_rule_idx on dismissals(rule_id, created_at desc);

-- ---------------------------------------------------------------- draft_edits (§11.3 edit-before-approve labels)
create table if not exists draft_edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  artifact_kind text not null,                 -- rsa_headline | rsa_description | change_spec | narration
  artifact_id text,
  drafted text not null,
  shipped text not null,
  diff jsonb not null default '{}'::jsonb,
  model_version text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- asset_perf_snapshots (§11.3 creative loop)
create table if not exists asset_perf_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid references runs(id),
  month date not null,                         -- first of month
  campaign_ref text,
  asset_type text not null check (asset_type in ('headline','description')),
  text text not null,
  performance_label text,                      -- Google's label as seen: BEST | GOOD | LOW | LEARNING | PENDING | UNSPECIFIED
  impressions_30d bigint not null default 0,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  unique(tenant_id, month, campaign_ref, asset_type, text)
);

-- ---------------------------------------------------------------- unanswered_log (§11.4 — the customer-written backlog)
create table if not exists unanswered_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  source text not null check (source in ('chat','composer','email_reply','support')),
  text text not null,
  cluster_id text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- anomaly_calendar (§11.7 seasonality)
create table if not exists anomaly_calendar (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),      -- null = market-level period (e.g. Ramadan, a Google outage)
  market text,                                 -- geo/market tag for null-tenant rows
  starts_on date not null,
  ends_on date not null,
  label text not null,
  created_from text not null default 'ops' check (created_from in ('ops','chat','ui','auto')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- tuning_log (§11.8/11.9 — tunings through the same pipeline)
create table if not exists tuning_log (
  id uuid primary key default gen_random_uuid(),
  proposal jsonb not null,                     -- { target: rule_config|registry|bounds|brief|weights, key, from, to }
  evidence jsonb not null default '{}'::jsonb, -- effect sizes, cohort, shadow results
  pr_ref text,
  status text not null default 'proposed' check (status in ('proposed','shadow','applied','reverted','rejected')),
  applied_at timestamptz,
  watch_id uuid references watches(id),
  outcome text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- model_usage (§9.9 usage metering, monthly per tenant)
create table if not exists model_usage (
  tenant_id uuid not null references tenants(id),
  month date not null,                         -- first of month
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(10,4) not null default 0,
  billing_consented_at timestamptz,
  billed_usd numeric(10,2) not null default 0,
  notified_80_at timestamptz,
  notified_100_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, month)
);

-- ---------------------------------------------------------------- telemetry_heartbeat (§11.9 instrumentation health)
create table if not exists telemetry_heartbeat (
  stream text primary key,                     -- events | dismissals | draft_edits | asset_perf | unanswered | model_usage | spend_daily
  last_write_at timestamptz not null default now(),
  writes_today int not null default 0
);

-- ---------------------------------------------------------------- RLS: service role only
alter table events enable row level security;
alter table dismissals enable row level security;
alter table draft_edits enable row level security;
alter table asset_perf_snapshots enable row level security;
alter table unanswered_log enable row level security;
alter table anomaly_calendar enable row level security;
alter table tuning_log enable row level security;
alter table model_usage enable row level security;
alter table telemetry_heartbeat enable row level security;
