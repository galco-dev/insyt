# Richer platform, same four doors: build spec (11 Sep 2026)

Ruling from Max: make the platform much richer while keeping it simple, so that a customer who has seen it wants to pay. Builds on the gated platform (claude/gated-platform-spec.md, shipped 11 Sep). For a Claude Code session in the insyt clone; CLAUDE.md carries the standing rules.

## 1. The principle

Keep the four tabs. Richness comes from each screen answering its one question with the customer's real numbers and with receipts, not from more tabs. The thing that sells a plan is the customer seeing, on their own account, money going out, money Insyt would stop, and proof that what Insyt did last week worked. Every new element must be one of those three or it does not go in.

Every element has a real state at every access level (locked, unlocked, active). Before a plan the same cards render with their numbers and a projection where an outcome would be; nothing reads as a placeholder or a padlock.

## 2. Home: the state of your ads

Order on the screen, top to bottom. Phone first.

1. Health row (exists): dial, one-line verdict, trend sparkline, "Latest report" link.
2. Money strip, three tiles: Spent this month (from spend_daily, with the pace line and budget if set), Going to waste (latest report summary.waste_monthly_usd, per month), Recovered since you joined (ledger_cumulative.waste_removed_usd). Below a plan the third tile reads "Would recover: about X a month" from access.pending_value_usd, with the projection chip (see §7). Tiles hide only when the underlying data has never existed (no spend snapshot yet), and then the strip becomes two tiles, never a blank third.
3. This week card. One card that tells the weekly story: last check (date, findings count), next check (coming Sunday, countdown in days), fixes applied this week, and their verification state from `watches` (kind changeset_verify: active = "watching", resolved = "verified", triggered = "reverted, we told you"). Copy pattern: "Checked Sunday, 7 findings. 3 fixes applied, 2 verified working, 1 still being watched. Next check in 4 days." Below a plan: "Checked Sunday, 7 findings. 4 fixes drafted, waiting for your yes. Next check in 4 days." Tapping opens History.
4. Needs you (exists): the pending cards with a total value line ("4 fixes, about X a month") and, at active, an "Approve all safe fixes" button when two or more pending changes are in the negatives or counting categories (server: POST /api/app/approve-batch with the ids; same gate as approve; the worker applies them as today).
5. Performance, 28 days: one chart, cost and conversions by day from spend_daily, with the weekly checks marked as small ticks and applied fixes as annotations (date + short title from ledger). Dependency-free SVG like packages/report/src/charts.js; both themes; grayscale series identity plus severity hues only where a fix mark carries a verdict. Shows only once spend_daily has 7 or more days; before that a one-line "Your daily numbers start building after the first check" inside the card, never an empty chart.
6. Your accounts: three compact rows (Google Ads, Analytics, Tag Manager) with a status dot, the account name or id, and "read 3 hours ago" from the latest run. Each row links to the matching Connected data tab. Reconnect appears inline when google_connections.status is not valid.
7. Alerts, only when present: rows from `alerts` for this tenant in the last 7 days (spend_spike, tag_down, disapproval, conv_flatline, pace_over) rendered as one line each with severity chip and time; acknowledging is a tap (POST /api/app/alerts/:id/ack). Section absent when there are none.

Home's Autopilot graduation card (10 yeses in a row) stays.

## 3. Report

- Top bar under the hero when two or more fixes are proposed: "Do all N fixes, about X a month" with one button. At active it approves the batch; at unlocked it opens the Plan sheet with kind `approve-batch`; at locked it is not shown (the unlock bar is the call). Fix this per finding stays.
- Each finding card that has been applied in a later run shows its receipt: "Fixed 3 Sep, verified 5 Sep" or "Fixed 3 Sep, watching". Source: changes joined to watches by target_id.
- Report list (History > Reports) rows gain the report's health score and waste figure from summary, so the archive reads as a trend.

## 4. Approvals

- Group cards by campaign when campaign_name exists on the finding; ungrouped section "Account-wide" for the rest. Groups collapse on phones after the first.
- Each card gains a severity chip (critical, warning, opportunity) and a "why now" line from ask_reason when present.
- "Approve all safe fixes" at the top under the same rule as Home.
- The request composer stays for everyone; the assistant chat replaces it automatically once a plan is active (server: assistantEnabled returns true when the tenant is active and deps.assistant exists, unless tenants.assistant_enabled is explicitly false). Decision for Max: this turns the assistant on for every paying customer; model cost is metered per tenant already (§9.9 allowance).

## 5. History

- Activity rows for fix_applied carry the verification receipt inline: outcome and the measured line from watches.baseline vs the resolved check ("Wasted-term clicks down 92% over 48 hours"), Undo stays. Rows for reverts say why.
- A month summary line at the top of Activity: "September: 9 fixes applied, 8 verified, 1 undone, about X a month recovered." Computed from ledger + watches for the current month.
- First-week preview below a plan (exists) stays.

## 6. Settings

- Weekly check card: the schedule (Sunday night, the customer's timezone from the browser at first sign-in, stored on tenants.timezone, new column), next run, "Check again now" moved here from the connection card, last three runs with status.
- Emails card: weekly report on/off (writes the same suppression the List-Unsubscribe uses), alerts always on (stated), the address emails go to.
- Business card: name, website, currency, size band with the plain-language explanation of the band. Editable name and website (POST /api/app/business), which feeds the report header.
- Plan, Google connection, Autopilot, Never touch, Your data, Signed in: as built.

## 7. Projections below a plan (the conversion layer)

One rule, used everywhere a result would appear before the customer has a plan: show the projection from the drafted fixes, labelled with a small chip "if approved", never blank and never a padlock. Home tile 3, the This week card, the Report top bar and the Approvals header all use access.pending_value_usd. The label is always the same two words so the customer learns it once. The moment a plan is active the chip disappears and the measured figure takes its place; where no measured figure exists yet the card says what will fill it ("first receipt lands 48 hours after your first fix").

## 8. Server and data

- New endpoints: GET /api/app/overview (money strip, this-week, accounts, alerts, performance series, in one round trip; Home uses it instead of /home for the new sections), POST /api/app/approve-batch, POST /api/app/alerts/:id/ack, POST /api/app/business, GET /api/app/runs (last three, for Settings). All rides on dashStore; access rides on every GET as today.
- Stores: overview(tenantId) composes spend_daily (28 days), reports summary, ledger_cumulative, watches for changes in the last 7 days, alerts (7 days, unacked first), assets (three kinds with display names), latest run finished_at. Keep every query tenant-scoped and single-table; no PostgREST subqueries (the 31 Aug settings bug).
- Migration 28: tenants.timezone text, tenants.email_reports boolean default true. Applied by hand to Supabase, file committed.
- Worker: nothing new; spend_daily and watches already exist. If the snapshot stage is not writing spend_daily for a tenant, the chart's empty line covers it honestly; log the gap.
- Demo: demo.js gains overview data for Glow Studio at all three levels, with a 28-day series and two watches, so every new element can be reviewed at /app?demo=1&access=locked|unlocked|active.

## 9. Copy rules

Customer register throughout (jargon linter applies to any new copy under apps/web/copy or client screens' shared strings; put new customer-facing strings where the linter sees them). No em dashes. Money in the account currency via the existing money helper; USD keeps the $.

## 10. Order of work

1. Overview endpoint + Home money strip, This week card, Your accounts (the biggest visible change, lowest risk).
2. Projection chip and its four uses; approve-batch (server, Home, Approvals, Report bar).
3. History receipts and month line; Report receipts; Reports list score and waste.
4. Performance chart.
5. Settings: weekly check, emails, business; migration 28.
6. Alerts on Home; assistant-on-for-active.
Each step: tests for the store composition and the routes, client build, screenshots at 400px in demo at all three levels, deploy request, deploy log checked, then the next step. Ship in at least two pushes so the first is live early.

## 11. Acceptance

A customer on the reviewer tenant (JobPeak) at unlocked sees on Home their real spend this month, their waste figure, a "would recover" tile with the chip, a This week card with real dates, and their three accounts with read times; on Approvals the header value line and grouped cards; on the report the "Do all" bar that opens the Plan sheet. After subscribing with a 4242 card the chip is gone, "Recovered" counts, the This week card shows applied and watching, and History shows a receipt 48 hours later. Nothing on any screen is a placeholder at any level. Tests green, jargon lint clean.
