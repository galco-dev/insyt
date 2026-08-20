-- Campaign creation + P1 rule set (agency-specialist audit).
--
-- campaign_drafts: creation modelled as the biggest possible "change"
-- (before: nothing → after: spec). Drafts flow approve → created PAUSED →
-- enable (a second explicit click) — never created enabled, never auto-
-- applied. agency_id null = consumer draft (Journey B / creation-as-finding).
create table campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  agency_id uuid references agencies(id),
  created_by uuid references agency_seats(id),   -- null for consumer drafts
  source_finding uuid,                            -- finding that suggested the build
  template text not null check (template in ('brand','generic','remarketing')),
  spec jsonb not null,
  status text not null default 'draft'
    check (status in ('draft','approved','created_paused','enabled','dismissed')),
  google_campaign_id text,                        -- set once the executor creates it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaign_drafts_tenant_idx on campaign_drafts(tenant_id, created_at desc);
create index campaign_drafts_agency_idx on campaign_drafts(agency_id, status);

-- P1 rules: RSA coverage/quality, campaign-build gaps, final-URL health.
insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('rsa.missing',                 4, 'critical',    '{}',                                          null, true),
  ('rsa.thin_assets',             4, 'warning',     '{"min_headlines":8,"min_descriptions":3}',    null, true),
  ('rsa.over_pinned',             4, 'warning',     '{"max_pinned":2}',                            null, true),
  ('rsa.poor_strength',           4, 'warning',     '{}',                                          null, true),
  ('ads.missing_brand_campaign',  4, 'opportunity', '{"min_spend_30d_usd":300}',                   null, true),
  ('ads.missing_remarketing',     4, 'opportunity', '{"min_spend_30d_usd":1000}',                  null, true),
  ('url.broken',                  5, 'critical',    '{}',                                          null, true),
  ('url.redirect_chain',          5, 'warning',     '{"max_hops":1}',                              null, true),
  ('url.slow',                    5, 'warning',     '{"max_load_ms":4000}',                        null, true)
on conflict (rule_id) do nothing;
