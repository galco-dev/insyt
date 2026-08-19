# Insyt

Google Ads, Analytics and Tag Manager, checked and fixed every week — with the customer's approval.

**Spec:** the project vault's `master-document` (strategy) and `build-document` (build spec) are the source of truth. This repo implements the build document.

## Layout

```
apps/web         app.tryinsyt.com — Journey A server slice (§11.1/.3/.4); React shell later
apps/worker      audit pipeline (§8): checkpointed stage runner + BullMQ service
apps/poller      watches pump (§15)
apps/cron        Sunday enqueue, deep-audit anniversaries, token sweep (§8, §15)
packages/shared  findings JSON contract (§2) — types
packages/db      Postgres schema as ordered migrations (§1) + PostgREST store adapters
packages/crawler discovery + verification crawler (§5)
packages/google  OAuth scope ladder, connection lifecycle, discovery + journey routing (§6–7)
packages/rules   rules engine core + all 5 layer rule modules (§2–3); health score (§13)
packages/report  run envelope, narration stage w/ grounding guard, email+web renderer (§2.3, §13)
packages/tools   the 16-tool constrained write surface + changeset executor (§4)
packages/billing Stripe catalogue from pricing_config + webhook mirror (§10)
packages/emails  template set, magic links, customer-facing copy — CI-linted (§12)
packages/journeys tag-install state machine (§9) + run scheduling (§8, §15)
scripts          CI tooling incl. the jargon linter (master §4); stripe + railway provisioning
deploy           Railway runbook (§15)
```

## Commands

```
npm test           # unit + local e2e tests
npm run crawl -- https://example.com   # discovery crawl, JSON to stdout
npm run lint:jargon
```

Crawler notes: respects robots.txt for depth pages; homepage always fetched; ≤5 nav-derived key pages; 15s homepage budget. `HTTPS_PROXY` honoured; `INSYT_INSECURE_TLS=1` is for TLS-intercepting dev proxies only.

## Environments

Secrets live in Railway env vars, never in the repo. Schema changes go through `packages/db/migrations` and are applied to Supabase in order.
