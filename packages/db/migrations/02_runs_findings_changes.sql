-- Insyt schema · build-doc §1.3 · runs, findings, changes, changesets, approvals, magic links

-- ---------------------------------------------------------------- runs
create table runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  type text not null check (type in ('signup_audit','weekly','deep','triggered','verification')),
  status text not null default 'queued' check (status in ('queued','running','degraded','complete','failed')),
  checkpoint jsonb not null default '{}',
  started_at timestamptz,
  finished_at timestamptz,
  cogs_usd numeric(10,4) not null default 0,
  model_usage jsonb not null default '{}',
  idempotency_key text unique
);
create index runs_tenant_idx on runs(tenant_id);
create index runs_status_idx on runs(status) where status in ('queued','running');

-- ---------------------------------------------------------------- rule_config
-- §3: thresholds and severity mapping live in data, tunable without deploy.
create table rule_config (
  rule_id text primary key,
  layer int not null check (layer between 1 and 5),
  default_severity text not null check (default_severity in ('critical','warning','opportunity','info')),
  thresholds jsonb not null default '{}',
  fix_tool_id text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- findings (THE central table)
create table findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  tenant_id uuid not null references tenants(id),
  rule_id text not null references rule_config(rule_id),
  layer int not null check (layer between 1 and 5),
  severity text not null check (severity in ('critical','warning','opportunity','info')),
  status text not null default 'open' check (status in ('open','approved','applied','dismissed','resolved','suspect')),
  title text not null,
  explanation text,
  money_impact_monthly_usd numeric(10,2),
  money_impact_currency_local jsonb,
  payload jsonb not null default '{}', -- the blurred part; never sent to unpaid sessions
  fix_available boolean not null default false,
  first_seen_run_id uuid references runs(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index findings_run_idx on findings(run_id);
create index findings_tenant_status_idx on findings(tenant_id, status);

-- ---------------------------------------------------------------- changesets (the revert unit, master §3.7)
create table changesets (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  tenant_id uuid not null references tenants(id),
  status text not null default 'open' check (status in ('open','applied','watching','verified','reverted')),
  watch_until timestamptz,
  reverted_at timestamptz,
  revert_reason text,
  created_at timestamptz not null default now()
);
create index changesets_tenant_idx on changesets(tenant_id);

-- ---------------------------------------------------------------- changes
create table changes (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references findings(id),
  changeset_id uuid references changesets(id),
  tenant_id uuid not null references tenants(id),
  tool_id text not null,
  target_asset_id uuid references assets(id),
  params jsonb not null default '{}',
  before jsonb,
  after jsonb,
  status text not null default 'proposed' check (status in ('proposed','approved','applied','failed','reverted')),
  applied_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index changes_tenant_idx on changes(tenant_id);
create index changes_changeset_idx on changes(changeset_id);

-- ---------------------------------------------------------------- approvals
create table approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  scope text not null check (scope in ('change','changeset','report','campaign_launch')),
  target_id uuid not null,
  channel text not null check (channel in ('email_magic_link','dashboard')),
  user_id uuid references users(id),
  approved_at timestamptz not null default now(),
  token_id uuid
);
create index approvals_tenant_idx on approvals(tenant_id);

-- ---------------------------------------------------------------- magic_links
create table magic_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  purpose text not null check (purpose in ('approve_all','approve_one','view_report','revert','reconnect','resume_journey')),
  target_id uuid,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index magic_links_tenant_idx on magic_links(tenant_id);

-- ---------------------------------------------------------------- RLS
alter table runs enable row level security;
alter table rule_config enable row level security;
alter table findings enable row level security;
alter table changesets enable row level security;
alter table changes enable row level security;
alter table approvals enable row level security;
alter table magic_links enable row level security;

create policy runs_self_read on runs for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy findings_self_read on findings for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy changesets_self_read on changesets for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy changes_self_read on changes for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy approvals_self_read on approvals for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
-- magic_links: no client policy at all — service role only.
-- rule_config: internal only — service role only.
