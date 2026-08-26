-- Insyt · engine-spec phase 4 — diff_pass + daily light pass.
-- APPLIED to Supabase 27 Aug 2026 (migration pulse_diff).

-- findings: first_seen_at carried across runs; 'superseded' = an older open row
-- replaced by this run's row for the same finding (health counts only the latest).
alter table findings add column if not exists first_seen_at timestamptz;
alter table findings add column if not exists resolved_run_id uuid references runs(id);
alter table findings drop constraint if exists findings_status_check;
alter table findings add constraint findings_status_check
  check (status in ('open','approved','applied','dismissed','resolved','suspect','superseded'));

-- daily light pass bookkeeping (§6.2): once a day per linked account
create table if not exists pulse_state (
  tenant_id uuid primary key references tenants(id),
  last_pulse_at timestamptz not null default now(),
  last_alerts int not null default 0,
  last_error text
);
alter table pulse_state enable row level security;

-- thresholds live in config, never code
insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('pulse.daily', 4, 'warning', '{"spike_multiple": 2.0, "spike_min_usd": 50, "silence_min_avg_usd": 20, "silence_max_pct": 10, "flatline_min_prior_conv": 1, "flatline_days": 3}', null, true)
on conflict (rule_id) do nothing;

-- ledger: resolved findings get their own line
alter table ledger drop constraint if exists ledger_event_check;
alter table ledger add constraint ledger_event_check check (event in (
  'fix_applied','fix_reverted','campaign_launched','report_sent','connection_changed','subscription_changed',
  'tag_verified','watch_triggered','change_requested','fix_proposed','autopilot_applied','watch_verified',
  'watch_inconclusive','watch_regressed','auto_reverted','exception_added','exception_cleared','engine_paused',
  'finding_resolved'
));
