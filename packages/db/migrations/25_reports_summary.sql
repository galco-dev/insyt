-- Compact per-report summary for the dashboard report page (health, waste,
-- counts, narrative); html_web stays the email/standalone rendering.
alter table reports add column if not exists summary jsonb;
update reports r set summary = jsonb_build_object(
  'health_score', (ru.checkpoint->'ctx'->>'health_score')::numeric,
  'waste_monthly_usd', (ru.checkpoint->'ctx'->'envelope'->'totals'->>'waste_monthly_usd')::numeric,
  'counts', ru.checkpoint->'ctx'->'envelope'->'counts',
  'exec_summary', ru.checkpoint->'ctx'->'envelope'->'narrative_slots'->>'exec_summary',
  'since_last_week', ru.checkpoint->'ctx'->'envelope'->'narrative_slots'->>'since_last_week'
) from runs ru where ru.id = r.run_id and r.summary is null;
