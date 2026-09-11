-- 31: Fix plan push 5 (move 13).
-- tenants.paused_until: a pause with a return date; checks, proposals, emails
-- and the bill stop until then (breakage alerts never stop).
-- subscriptions.canceled_at: Undo stays free for 30 days after cancelling.
-- payments.refunded_at: a refunded audit fee relocks the report.
alter table tenants add column if not exists paused_until timestamptz;
alter table subscriptions add column if not exists canceled_at timestamptz;
alter table payments add column if not exists refunded_at timestamptz;
