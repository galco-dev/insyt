-- Insyt · rule_config seed — Layer 4 (Ads closure) launch defaults, build-doc §3.
-- The first layer with measured money. Thresholds are launch guesses per
-- master §3 — dogfooding against JobPeak/The Nail DXB/fyn tunes them.
-- ads.tcpa_blind emits both options (pause vs fix-tracking-first); the seeded
-- fix tool is the pause path, the alternative rides in payload.options.

insert into rule_config (rule_id, layer, default_severity, thresholds, fix_tool_id, enabled) values
  ('ads.no_conversion_tracking',    4, 'critical',    '{"min_spend_90d_usd": 100}',                              null,                        true),
  ('ads.conversion_silent',         4, 'critical',    '{"silent_days": 14}',                                     null,                        true),
  ('ads.tcpa_blind',                4, 'critical',    '{"silent_days": 14}',                                     'ads.pause_campaign',        true),
  ('ads.dual_primary',              4, 'critical',    '{}',                                                      'ads.set_action_secondary',  true),
  ('ads.divergence',                4, 'warning',     '{"tolerance_pct": 40, "min_conversions": 10}',            null,                        true),
  ('ads.wasted_terms',              4, 'warning',     '{"min_term_spend_90d_usd": 5, "min_total_spend_90d_usd": 50}', 'ads.add_negative_keywords', true),
  ('ads.budget_constrained_winner', 4, 'opportunity', '{"min_budget_lost_is_pct": 10, "min_conversions_30d": 3}', 'ads.adjust_budget',        true),
  ('ads.budget_bleeding_loser',     4, 'warning',     '{"min_spend_30d_usd": 100, "cpa_multiple": 2}',           'ads.adjust_budget',         true),
  ('ads.disapproved_ads',           4, 'warning',     '{}',                                                      null,                        true)
on conflict (rule_id) do nothing;
