-- Gated platform (spec §5): the Stripe customer the $20 unlock creates is
-- remembered so the plan checkout offers the saved card and the billing
-- portal works before any subscription exists.
alter table payments add column if not exists stripe_customer_id text;
create index if not exists payments_customer_idx on payments(stripe_customer_id);
