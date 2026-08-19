-- Insyt schema · build-doc §1.1–1.2 · identity, tenancy, assets, crawls
-- Conventions: UUID PKs, timestamptz, no soft deletes, RLS on every tenant-owned table.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenants
create table tenants (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','paused','cancelled')),
  business_name text,
  website_url text,
  cms_platform text check (cms_platform in ('shopify','wordpress','webflow','wix','squarespace','unsupported') or cms_platform is null),
  vertical text,
  geo text,
  size_band text check (size_band in ('4k','10k','25k') or size_band is null),
  benchmark_consent boolean not null default false
);

-- ---------------------------------------------------------------- users
create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  google_sub text unique not null,
  email text not null,
  name text,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index users_tenant_idx on users(tenant_id);

-- ---------------------------------------------------------------- google_connections
create table google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  refresh_token text, -- encrypted at rest via Supabase Vault; this column stores the vault secret id
  granted_scopes text[] not null default '{}',
  scope_level text not null default 'readonly' check (scope_level in ('readonly','write','create')),
  status text not null default 'valid' check (status in ('valid','expired','revoked','partial')),
  last_validated_at timestamptz
);
create index google_connections_user_idx on google_connections(user_id);

-- ---------------------------------------------------------------- assets
create table assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('ads_account','ga4_property','gtm_container','ga4_stream')),
  external_id text not null,
  display_name text,
  currency text,
  linked boolean not null default false,
  created_by_us boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, external_id)
);
create index assets_tenant_idx on assets(tenant_id);

-- ---------------------------------------------------------------- crawls
-- Pre-signup: keyed by URL + anonymous session; adopted by tenant on signup.
create table crawls (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  url text not null,
  tenant_id uuid references tenants(id),
  cms_fingerprint text,
  tags_found jsonb not null default '{}',
  booking_provider text,
  pages_crawled int not null default 0,
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  created_at timestamptz not null default now()
);
create index crawls_url_idx on crawls(url);
create index crawls_session_idx on crawls(session_id);
create index crawls_tenant_idx on crawls(tenant_id);

-- ---------------------------------------------------------------- RLS
-- Workers use the service role (bypasses RLS). Authenticated app users may read
-- only their own tenant's rows; all writes go through the service layer.
alter table tenants enable row level security;
alter table users enable row level security;
alter table google_connections enable row level security;
alter table assets enable row level security;
alter table crawls enable row level security;

create policy tenant_self_read on tenants for select
  using (id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy users_self_read on users for select
  using (tenant_id in (select tenant_id from users u where u.google_sub = (auth.jwt() ->> 'sub')));
create policy connections_self_read on google_connections for select
  using (user_id in (select id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy assets_self_read on assets for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy crawls_self_read on crawls for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
