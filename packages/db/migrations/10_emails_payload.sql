-- Insyt · emails.payload — template vars / subject override for the §12 send
-- loop (packages/emails/src/sender.js). Migration 10.
alter table emails add column if not exists payload jsonb not null default '{}';
