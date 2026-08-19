-- Insyt · rule_config seed — Layer 1 (GTM) launch defaults, build-doc §3.
-- Severity and thresholds are DATA: dogfooding tunes these rows, never code.
-- fix_tool_id references the §4 constrained tool catalogue.

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('gtm.duplicate_ga4_tags',  1, 'critical', '{}',                    'gtm.pause_tag',              true),
  ('gtm.orphan_tags',         1, 'info',     '{}',                    null,                         true), -- remove_tag is brief-only default
  ('gtm.id_mismatch',         1, 'critical', '{}',                    'gtm.update_tag_config',      true),
  ('gtm.legacy_debris',       1, 'warning',  '{}',                    'gtm.pause_tag',              true),
  ('gtm.consent_mode_absent', 1, 'warning',  '{}',                    null,                         true), -- brief-only
  ('gtm.unpublished_changes', 1, 'info',     '{"stale_days": 7}',     'gtm.publish',                true),
  ('gtm.version_regression',  1, 'critical', '{"min_drop_pct": 50}',  'gtm.restore_version_element', true)
on conflict (rule_id) do nothing;
