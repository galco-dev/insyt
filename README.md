# Insyt

Google Ads, Analytics and Tag Manager, checked and fixed every week — with the customer's approval.

**Spec:** the project vault's `master-document` (strategy) and `build-document` (build spec) are the source of truth. This repo implements the build document.

## Layout

```
apps/web         app.tryinsyt.com (React) — not started
apps/worker      audit pipeline workers — not started
packages/shared  findings JSON contract (§2) — types
packages/db      Postgres schema as ordered migrations (§1)
packages/crawler discovery + verification crawler (§5)
packages/google  OAuth scope ladder, connection lifecycle, discovery + journey routing (§6–7)
packages/rules   rules engine core + layer rule modules (§2–3); health score (§13)
scripts          CI tooling incl. the jargon linter (master §4)
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
