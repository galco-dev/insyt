-- Insyt · engine-spec phase 6 — the learning layer's review artefact (§11.9).
-- APPLIED to Supabase 27 Aug 2026 (migration learning).
-- Proposals live in tuning_log (migration 17); this table is the monthly
-- "diffs with receipts" document, one per month, idempotency key for the job.
create table if not exists learning_reviews (
  month date primary key,
  body_md text not null,
  proposals jsonb not null default '{}'::jsonb,   -- { chosen, carried, backlog, rejected }
  incidents jsonb not null default '[]'::jsonb,   -- telemetry heartbeat incidents
  reviewed_by text,                               -- set when a human has read it (PR merged / ops ack)
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table learning_reviews enable row level security;
