-- 35: Agency plan push 4 (moves 9, 10 and 11).
-- Per account: hold reports for review, how the client's own app behaves,
-- whether the client is copied on emails. Per agency: timezone for the
-- morning digest and a fallback address for routed emails.
alter table agency_accounts add column if not exists review_reports boolean not null default true;
alter table agency_accounts add column if not exists client_mode text not null default 'shared' check (client_mode in ('shared','read_only'));
alter table agency_accounts add column if not exists client_copy boolean not null default false;
alter table agencies add column if not exists timezone text;
alter table agencies add column if not exists notify_email text;
-- An agency dismissal is a dismissal, not a failed fix, so the client's
-- History never offers a Retry on it.
alter table changes drop constraint if exists changes_status_check;
alter table changes add constraint changes_status_check check (status in ('proposed','approved','applied','failed','reverted','dismissed'));
alter table ledger drop constraint if exists ledger_event_check;
alter table ledger add constraint ledger_event_check check (event in (
  'fix_applied','fix_reverted','campaign_launched','report_sent','connection_changed','subscription_changed',
  'tag_verified','watch_triggered','change_requested','fix_proposed','autopilot_applied','watch_verified',
  'watch_inconclusive','watch_regressed','auto_reverted','exception_added','exception_cleared','engine_paused',
  'finding_resolved','fix_failed','fix_deferred','fix_approved','fix_dismissed'
));
