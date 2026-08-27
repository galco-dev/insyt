-- Insyt · engine-spec phase 3 — journeyB.setup_incomplete (§3.3/§5.1) rule config.
-- APPLIED to Supabase 27 Aug 2026 (migration journey_rule).
insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('journeyB.setup_incomplete', 6, 'warning', '{}', null, true)
on conflict (rule_id) do nothing;
