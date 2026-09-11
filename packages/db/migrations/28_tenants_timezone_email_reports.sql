-- 28: Settings, richer platform step 5.
-- tenants.timezone: the browser's zone at first sign-in, so the weekly check
-- card can say when the check runs in the customer's own time.
-- tenants.email_reports: weekly report emails on or off. The Settings toggle
-- and the List-Unsubscribe link write the same flag; alerts are never gated.
alter table tenants add column if not exists timezone text;
alter table tenants add column if not exists email_reports boolean not null default true;
-- A queued report email for a tenant who turned reports off is marked
-- suppressed by the drain, never sent and never mis-filed as a bounce.
alter table emails drop constraint if exists emails_status_check;
alter table emails add constraint emails_status_check check (status in ('queued','sent','delivered','bounced','opened','suppressed'));
