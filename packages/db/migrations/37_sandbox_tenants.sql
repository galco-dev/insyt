-- 37: sandbox tenants. A flagged tenant is treated as active on a plan with
-- nothing to pay, so a test account can exercise every screen and write
-- without Stripe. Set by hand, never from the app.
alter table tenants add column if not exists sandbox boolean not null default false;
