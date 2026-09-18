-- Server-side conversion backstop (tracking brief Part C, 18 Sep 2026). When
-- a payment lands and the tenant carries a Google click id, the webhook
-- records the conversion here. Nothing uploads it yet; the Stripe id is the
-- order id so Google de-duplicates against the browser tag when it does.
create table if not exists ad_conversions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  conversion_name text not null check (conversion_name in ('report_unlocked','launch_bundle_purchased','subscription_started')),
  gclid text,
  gbraid text,
  wbraid text,
  value_usd numeric(10,2) not null default 0,
  currency text not null default 'USD',
  converted_at timestamptz not null default now(),
  stripe_id text not null,
  uploaded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversion_name, stripe_id)
);
create index if not exists ad_conversions_tenant_idx on ad_conversions(tenant_id);
