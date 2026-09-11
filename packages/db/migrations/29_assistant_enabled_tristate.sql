-- 29: Richer platform step 6. The assistant is on for every tenant with an
-- active plan; tenants.assistant_enabled becomes a tri-state override:
-- null = follow the plan, true = on regardless, false = off regardless.
alter table tenants alter column assistant_enabled drop not null;
alter table tenants alter column assistant_enabled set default null;
update tenants set assistant_enabled = null where assistant_enabled = false;
