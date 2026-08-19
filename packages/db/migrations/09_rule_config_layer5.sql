-- Insyt · rule_config seed — Layer 5 (live witness) launch defaults, build-doc §3.
-- container_missing and coverage_gap route to the §9 install/corrective flows,
-- tag_alive to the breakage-alert path — none are one-tap tool fixes.

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('live.container_missing', 5, 'critical', '{}', null,                    true),
  ('live.collect_wrong_id',  5, 'critical', '{}', 'gtm.update_tag_config', true),
  ('live.coverage_gap',      5, 'warning',  '{}', null,                    true),
  ('live.tag_alive',         5, 'critical', '{}', null,                    true)
on conflict (rule_id) do nothing;
