-- 36: a $0 Checkout (100% promotion code) creates no PaymentIntent. The
-- payment row keys on the Checkout session instead; the intent is optional.
alter table payments alter column stripe_payment_intent drop not null;
alter table payments add column if not exists stripe_session_id text;
create unique index if not exists payments_session_idx on payments(stripe_session_id) where stripe_session_id is not null;
alter table payments add column if not exists promotion_code text;
