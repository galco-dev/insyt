-- Insyt · rule_config seed — Layer 6 (deep audit) launch defaults.
-- Widens the layer check (was 1..5) for the new deep layer, then seeds.
-- The rule families proven by the hand-built deep report (The Nail DXB,
-- 20 Aug 2026), made deterministic. Thresholds are launch guesses; tuning
-- happens in rule_config rows, never in code. Modelled money (qs.low_average,
-- ads.growth_headroom) carries confidence 'model' and renders labelled.
-- APPLIED to Supabase 22 Aug 2026 (migration rule_config_deep).

alter table rule_config drop constraint rule_config_layer_check;
alter table rule_config add constraint rule_config_layer_check check (layer >= 1 and layer <= 6);

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('qs.low_average',             6, 'warning',     '{"min_scored_keywords": 8, "top_n": 30, "max_avg_qs": 5, "premium_pct": 25}', null,                        true),
  ('qs.nonconverter_floor',      6, 'warning',     '{"max_qs": 2, "min_spend_usd": 20}',                                         'ads.pause_keywords',        true),
  ('ads.hour_waste',             6, 'warning',     '{"cpa_multiple": 2, "min_hour_spend_usd": 40}',                              null,                        true),
  ('ads.dow_waste',              6, 'warning',     '{"cpa_multiple": 3, "min_day_spend_usd": 100}',                              null,                        true),
  ('ads.device_cpa_skew',        6, 'info',        '{"cpa_multiple": 1.5, "min_device_spend_usd": 100}',                         null,                        true),
  ('ads.growth_headroom',        6, 'opportunity', '{"max_click_share_pct": 15}',                                                null,                        true),
  ('ads.lost_is_budget',         6, 'opportunity', '{"min_lost_is_pct": 15}',                                                    'ads.adjust_budget',         true),
  ('ads.invalid_clicks_high',    6, 'info',        '{"max_invalid_pct": 8}',                                                     null,                        true),
  ('ads.language_demand',        6, 'opportunity', '{"min_converting_terms": 2}',                                                null,                        true),
  ('ads.competitor_name_drift',  6, 'warning',     '{"min_cluster_spend_90d_usd": 30}',                                          'ads.add_negative_keywords', true),
  ('ads.out_of_area',            6, 'warning',     '{"min_cluster_spend_90d_usd": 20}',                                          'ads.add_negative_keywords', true),
  ('ads.off_menu_queries',       6, 'warning',     '{"min_cluster_spend_90d_usd": 30}',                                          'ads.add_negative_keywords', true),
  ('truth.price_mismatch',       6, 'critical',    '{}',                                                                          null,                        true),
  ('trend.cpc_escalation',       6, 'warning',     '{"cpc_multiple": 2.5}',                                                      null,                        true),
  ('trend.cpa_regression',       6, 'warning',     '{"cpa_multiple": 1.5}',                                                      null,                        true)
on conflict (rule_id) do nothing;
