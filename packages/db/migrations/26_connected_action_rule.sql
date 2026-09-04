-- Insyt · Connected data screen (Settings → "See what Insyt reads"): the
-- synthetic finding every user-initiated Ads action hangs off (changes.finding_id
-- is not null and findings.rule_id references rule_config).
-- APPLIED to Supabase 4 Sep 2026 (via MCP execute_sql).
insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('user.connected_action', 4, 'info', '{"source":"connected_data","note":"user-initiated action from Settings > Connected data; not a detector"}', null, true)
on conflict (rule_id) do nothing;
