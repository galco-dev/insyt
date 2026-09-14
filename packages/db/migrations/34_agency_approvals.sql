-- 34: Agency plan push 3 (moves 7 and 8).
-- An agency approval is its own channel on the approvals row, and the client's
-- History gets a line at approval time, before the worker applies anything.
alter table approvals drop constraint if exists approvals_channel_check;
alter table approvals add constraint approvals_channel_check check (channel in ('email_magic_link','dashboard','autopilot','chat','agency'));
alter table ledger drop constraint if exists ledger_event_check;
alter table ledger add constraint ledger_event_check check (event in (
  'fix_applied','fix_reverted','campaign_launched','report_sent','connection_changed','subscription_changed',
  'tag_verified','watch_triggered','change_requested','fix_proposed','autopilot_applied','watch_verified',
  'watch_inconclusive','watch_regressed','auto_reverted','exception_added','exception_cleared','engine_paused',
  'finding_resolved','fix_failed','fix_deferred','fix_approved'
));
