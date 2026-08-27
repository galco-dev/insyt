-- Gate 4: every public table behind RLS. Services use the service role
-- (bypasses RLS); end users never query PostgREST directly, so no policies.
alter table agencies enable row level security;
alter table agency_seats enable row level security;
alter table brand_kits enable row level security;
alter table audit_credit_events enable row level security;
alter table agency_audit_log enable row level security;
alter table agency_accounts enable row level security;
alter table account_targets enable row level security;
alter table spend_daily enable row level security;
alter table campaigns enable row level security;
alter table alerts enable row level security;
alter table campaign_drafts enable row level security;
-- Views must not escalate to their creator's rights.
alter view ledger_cumulative set (security_invoker = true);
alter view agency_credit_balance set (security_invoker = true);
-- Trigger function with a pinned search_path.
alter function forbid_mutation() set search_path = public;
