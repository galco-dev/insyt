-- Insyt · engine-spec phase 2 — change registry provenance, per-change
-- verification watches, standing exceptions, rollback links.
-- APPLIED to Supabase 27 Aug 2026 (migration registry_watches_exceptions).

-- changes: registry provenance + the dispute trail (§7.3 actors never blurred)
alter table changes add column if not exists change_key text;       -- canonical key: tool:target:params-hash (dedup + exceptions)
alter table changes add column if not exists target text;           -- resource key (one change in flight per resource)
alter table changes add column if not exists category text check (category in ('negatives','budgets','counting'));
alter table changes add column if not exists actor text not null default 'user'
  check (actor in ('user','autopilot','user_via_chat','system'));
alter table changes add column if not exists summary_text text;
alter table changes add column if not exists money_impact_usd numeric(10,2);
alter table changes add column if not exists reverts_change_id uuid references changes(id);
alter table changes add column if not exists ask_reason text;       -- why this became a card rather than autopilot
alter table changes add column if not exists watch_plan jsonb;      -- { kind, days, baseline } captured at draft time
create index if not exists changes_change_key_idx on changes(tenant_id, change_key);
create index if not exists changes_target_idx on changes(tenant_id, target) where status in ('proposed','approved');

-- watches: per-change verification kind (§4.4); outcome/effect columns came with migration 17
alter table watches drop constraint if exists watches_kind_check;
alter table watches add constraint watches_kind_check
  check (kind in ('tag_alive','changeset_verify','first_conversion','first_click','change_verify'));

-- standing exceptions (§4.5): "what have I told you never to touch?"
create table if not exists standing_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  change_key text not null,
  target text,
  summary_text text not null,
  created_from text not null default 'ui' check (created_from in ('ui','chat','revert','email')),
  reason text,
  source_change_id uuid references changes(id),
  created_at timestamptz not null default now(),
  cleared_at timestamptz
);
create index if not exists standing_exceptions_tenant_idx on standing_exceptions(tenant_id) where cleared_at is null;

-- approvals: autopilot is a channel of its own (standing consent, §7.2 lane 1)
alter table approvals drop constraint if exists approvals_channel_check;
alter table approvals add constraint approvals_channel_check check (channel in ('email_magic_link','dashboard','autopilot','chat'));

-- ledger: new events the phase writes
alter table ledger drop constraint if exists ledger_event_check;
alter table ledger add constraint ledger_event_check check (event in (
  'fix_applied','fix_reverted','campaign_launched','report_sent','connection_changed','subscription_changed',
  'tag_verified','watch_triggered','change_requested','fix_proposed','autopilot_applied','watch_verified',
  'watch_inconclusive','watch_regressed','auto_reverted','exception_added','exception_cleared','engine_paused'
));

alter table standing_exceptions enable row level security;
create policy exceptions_self_read on standing_exceptions for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
