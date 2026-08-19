-- Insyt · rule_config seed — Layer 3 (firing verification) launch defaults, build-doc §3.
-- The money layer. fire.volume_anomaly's default severity is overridden by
-- magnitude in code (critical ≥ critical_drop_pct, warning ≥ warning_drop_pct).
-- fire.configured_never_fired routes to cause — no single fix tool.
-- fire.plausibility bands start empty and tighten as benchmark data accumulates.

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('fire.configured_never_fired', 3, 'critical', '{"window_days": 30}',                                                        null,                          true),
  ('fire.event_stopped',          3, 'critical', '{"quiet_days": 7, "min_prior_daily": 1}',                                    'gtm.restore_version_element', true),
  ('fire.param_integrity',        3, 'warning',  '{"max_null_pct": 10}',                                                       'gtm.update_tag_config',       true),
  ('fire.plausibility',           3, 'warning',  '{"min_sessions": 100, "bands": {}}',                                         null,                          true),
  ('fire.volume_anomaly',         3, 'warning',  '{"critical_drop_pct": 80, "warning_drop_pct": 50, "min_baseline_daily": 3}', null,                          true)
on conflict (rule_id) do nothing;
