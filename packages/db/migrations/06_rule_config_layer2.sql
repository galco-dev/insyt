-- Insyt · rule_config seed — Layer 2 (GA4 config) launch defaults, build-doc §3.

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('ga4.no_key_events',           2, 'critical', '{}',                             'ga4.create_key_event', true),
  ('ga4.key_event_wrong',         2, 'warning',  '{}',                             'ga4.update_key_event', true),
  ('ga4.ads_link_missing',        2, 'critical', '{}',                             'ga4.create_ads_link',  true),
  ('ga4.ads_link_recent',         2, 'info',     '{}',                             null,                   true),
  ('ga4.retention_short',         2, 'info',     '{}',                             'ga4.set_retention',    true),
  ('ga4.enhanced_double_fire',    2, 'warning',  '{}',                             'gtm.pause_tag',        true),
  ('ga4.attribution_nonstandard', 2, 'info',     '{"recent_change_days": 90}',     null,                   true)
on conflict (rule_id) do nothing;
