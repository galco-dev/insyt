-- A change drafted from a request (chat, the composer, autopilot-on) has no
-- finding behind it; the column was still not null from migration 02, so
-- every such card failed to insert. Findings-driven changes keep their link.
alter table changes alter column finding_id drop not null;
