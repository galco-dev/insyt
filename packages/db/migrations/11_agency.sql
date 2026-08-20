-- Insyt schema · master-doc §13 · agency tier v1
-- Agencies manage many client tenants. Binding rules: no auto-apply, no
-- auto-publish — every account change needs an agency seat's approval, every
-- client-visible report passes the review queue. Per-seat audit trail.

create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','paused','closed')),
  platform_tier text not null default 'base' check (platform_tier in ('base','mid','top')),
  audit_credits_monthly int not null default 3,
  created_at timestamptz not null default now()
);

create table agency_seats (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  email text not null,
  name text,
  google_sub text unique,
  tenant_id uuid references tenants(id), -- set when the seat first signs in (session bridge)
  role text not null default 'am' check (role in ('admin','am','readonly')),
  status text not null default 'invited' check (status in ('invited','active','disabled')),
  created_at timestamptz not null default now()
);
create index agency_seats_agency_idx on agency_seats(agency_id);
create index agency_seats_tenant_idx on agency_seats(tenant_id);

create table agency_accounts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  tenant_id uuid not null references tenants(id),
  display_name text not null,
  seat_id uuid references agency_seats(id), -- assigned account manager
  brief_only boolean not null default false, -- Apply buttons hidden; briefs only
  report_register text not null default 'simple' check (report_register in ('simple','technical')),
  status text not null default 'active' check (status in ('active','paused','removed')),
  created_at timestamptz not null default now(),
  unique(agency_id, tenant_id)
);
create index agency_accounts_agency_idx on agency_accounts(agency_id);

-- Brand kits are versioned: a rebrand never alters already-issued reports.
create table brand_kits (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  version int not null,
  display_name text,
  logo_light_url text,
  logo_dark_url text,
  color_primary text,
  color_accent text,
  footer_text text,
  created_at timestamptz not null default now(),
  unique(agency_id, version)
);

-- Audit credits: append-only ledger; balance is a view.
create table audit_credit_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  delta int not null,
  reason text not null check (reason in ('monthly_grant','prospect_audit','purchase','adjustment')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create view agency_credit_balance as
  select agency_id, coalesce(sum(delta), 0) as balance
  from audit_credit_events group by agency_id;

-- Per-seat audit trail — the agency's own client-dispute record.
create table agency_audit_log (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id),
  seat_id uuid references agency_seats(id),
  event text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index agency_audit_agency_idx on agency_audit_log(agency_id, created_at);

-- Review queue rides on reports: client-visible only after approval.
alter table reports add column review_status text
  check (review_status in ('pending','approved','rejected'));
alter table reports add column reviewed_by uuid; -- agency_seats.id
alter table reports add column reviewed_at timestamptz;
