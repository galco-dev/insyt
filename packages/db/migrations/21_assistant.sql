-- Insyt · engine-spec phase 5 — the assistant (§7) + usage metering (§9.9).
-- APPLIED to Supabase 27 Aug 2026 (migration assistant).

-- Chat is never the system of record (§7.4.1): transcripts are personal data,
-- 12-month rolling retention (§9.8), included in export / delete-my-data.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  retention_until timestamptz not null
);
create index if not exists conversations_tenant_idx on conversations(tenant_id, last_message_at desc);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  role text not null check (role in ('user','assistant','system')),
  text text not null,
  model_version text,                       -- stamped on every assistant reply (§1 attribution)
  "references" jsonb not null default '{}'::jsonb,  -- which read tools grounded the answer
  change_id uuid references changes(id),    -- the card this turn drafted, if any
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages(conversation_id, created_at);

-- per-tenant feature flag (§7.6 rollout: flag → demo → beta → general)
alter table tenants add column if not exists assistant_enabled boolean not null default false;

-- the user's own words ride on bot-drafted cards (§7.3 provenance / dispute trail)
alter table changes add column if not exists request_text text;

-- budget resource name on the campaign snapshot so chat-drafted budget moves can execute
alter table campaigns add column if not exists budget_resource text;

alter table conversations enable row level security;
alter table messages enable row level security;
create policy conversations_self_read on conversations for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
create policy messages_self_read on messages for select
  using (tenant_id in (select tenant_id from users where google_sub = (auth.jwt() ->> 'sub')));
