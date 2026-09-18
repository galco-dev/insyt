-- Landing attribution (tracking brief, 18 Sep 2026): the marketing site's
-- src and trade and Google's click ids, kept on the check a visitor ran and
-- copied to their tenant at Google sign-in. Read by the Stripe webhook
-- backstop (Part C); never shown to the customer.
alter table crawls add column if not exists attribution jsonb;
alter table tenants add column if not exists attribution jsonb;
