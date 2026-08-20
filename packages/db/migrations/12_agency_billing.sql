-- Agency billing anchors + brand-kit freezing on reports.
-- Billing principle (binding): the platform bills the AGENCY for the platform.
-- It never stores, computes or displays what the agency charges its clients.

alter table agencies add column stripe_customer_id text;
alter table agencies add column stripe_subscription_id text;
alter table agencies add column billing_anchor date; -- monthly cycle anchor (signup date)

-- Reports freeze the brand kit version they shipped with (rebrands never
-- alter archives).
alter table reports add column brand_kit_version int;

-- Account rows need a state before Google is connected.
alter table agency_accounts drop constraint agency_accounts_status_check;
alter table agency_accounts add constraint agency_accounts_status_check
  check (status in ('pending','active','paused','removed'));
