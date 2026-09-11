-- 32: Fix plan push 6 (moves 12 and 15).
-- users: a viewer role (read-only, invited by the owner), and one Google
-- identity may own more than one business (unique per tenant, not global).
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('owner','viewer'));
alter table users drop constraint if exists users_google_sub_key;
alter table users add constraint users_google_sub_tenant_key unique (google_sub, tenant_id);

-- One calm banner on Home for everyone when Google is having a day.
create table if not exists platform_notices (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table platform_notices enable row level security;

-- Delete a tenant from ops without SQL by hand: forty tables in order, the
-- two append-only guards lifted inside this one transaction.
create or replace function delete_tenant(p_tenant uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  alter table ledger disable trigger ledger_no_update;
  alter table audit_log disable trigger audit_no_update;
  delete from tuning_log where watch_id in (select id from watches where tenant_id = p_tenant);
  delete from dismissals where tenant_id = p_tenant;
  delete from ledger where tenant_id = p_tenant;
  delete from messages where tenant_id = p_tenant;
  delete from conversations where tenant_id = p_tenant;
  delete from standing_exceptions where tenant_id = p_tenant;
  delete from emails where tenant_id = p_tenant;
  delete from approvals where tenant_id = p_tenant;
  delete from changes where tenant_id = p_tenant;
  delete from changesets where tenant_id = p_tenant;
  delete from findings where tenant_id = p_tenant;
  delete from reports where tenant_id = p_tenant;
  delete from asset_perf_snapshots where tenant_id = p_tenant;
  delete from token_metering where tenant_id = p_tenant;
  delete from runs where tenant_id = p_tenant;
  delete from assets where tenant_id = p_tenant;
  delete from crawls where tenant_id = p_tenant;
  delete from events where tenant_id = p_tenant;
  delete from journey_state where tenant_id = p_tenant;
  delete from autopilot_settings where tenant_id = p_tenant;
  delete from pulse_state where tenant_id = p_tenant;
  delete from magic_links where tenant_id = p_tenant;
  delete from model_usage where tenant_id = p_tenant;
  delete from spend_daily where tenant_id = p_tenant;
  delete from campaigns where tenant_id = p_tenant;
  delete from campaign_drafts where tenant_id = p_tenant;
  delete from draft_edits where tenant_id = p_tenant;
  delete from alerts where tenant_id = p_tenant;
  delete from account_targets where tenant_id = p_tenant;
  delete from anomaly_calendar where tenant_id = p_tenant;
  delete from audit_log where tenant_id = p_tenant;
  delete from payments where tenant_id = p_tenant;
  delete from subscriptions where tenant_id = p_tenant;
  delete from unanswered_log where tenant_id = p_tenant;
  delete from watches where tenant_id = p_tenant;
  delete from agency_accounts where tenant_id = p_tenant;
  delete from agency_seats where tenant_id = p_tenant;
  delete from google_connections where user_id in (select id from users where tenant_id = p_tenant);
  delete from users where tenant_id = p_tenant;
  delete from tenants where id = p_tenant;
  alter table ledger enable trigger ledger_no_update;
  alter table audit_log enable trigger audit_no_update;
end $$;
