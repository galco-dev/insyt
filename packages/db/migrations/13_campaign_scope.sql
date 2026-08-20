-- Campaign snapshots (refreshed by each audit run) power the agency scope
-- bar and campaign search without live Google calls. Findings that belong to
-- a specific campaign carry its reference; account-level findings (GTM/GA4)
-- stay null and surface as "account-wide — affects this campaign too" when a
-- campaign scope is active.

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  google_campaign_id text not null,
  name text not null,
  status text, -- as last seen: enabled | paused | removed
  channel text, -- search | pmax | display | video | shopping
  budget_daily_usd numeric(10,2),
  bidding text,
  last_seen_at timestamptz not null default now(),
  unique(tenant_id, google_campaign_id)
);
create index campaigns_tenant_idx on campaigns(tenant_id);

alter table findings add column campaign_ref text;  -- google_campaign_id
alter table findings add column campaign_name text; -- denormalised at write
