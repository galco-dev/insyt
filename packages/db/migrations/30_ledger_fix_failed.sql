-- 30: Fix plan push 4 (move 9). A fix Google refused gets a receipt in
-- History, in plain words, with a retry; a deferred one says so too.
alter table ledger drop constraint if exists ledger_event_check;
alter table ledger add constraint ledger_event_check check (event in (
  'fix_applied','fix_reverted','campaign_launched','report_sent','connection_changed','subscription_changed',
  'tag_verified','watch_triggered','change_requested','fix_proposed','autopilot_applied','watch_verified',
  'watch_inconclusive','watch_regressed','auto_reverted','exception_added','exception_cleared','engine_paused',
  'finding_resolved','fix_failed','fix_deferred'
));
