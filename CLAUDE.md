# Insyt (app.tryinsyt.com): working rules for Claude Code

Insyt audits and fixes Google Ads, GA4 and Tag Manager for small businesses, with every change approved by the customer. Company: Galco FZ-LLC (Max Galledari). Product and build specs live in the claude.ai project "Tryinsyt.com" (master-document, build-document, engine-spec, gated-platform-spec); this file carries only what a coding session needs.

## Stack and layout
- Framework-free Node 22 server: `apps/web/src/server.js` (routes), `main.js` (wiring), `auth-routes.js`, `connected.js`.
- React 18 + Vite + Tailwind v4 SPA: `apps/web/client/src` (screens/, report/, lib/, connected/, agency/). Builds into `apps/web/public/app` (gitignored; Railway builds it). Vendored UUI kit at `apps/web/client/src/uui` (do not edit).
- `apps/worker` (audit pipeline, apply loop), `apps/poller`, `apps/cron`. Packages: `db` (PostgREST stores + `migrations/`), `rules`, `report`, `tools`, `billing`, `emails`, `google`, `crawler`, `campaigns`, `journeys`, `shared`.
- Data: Supabase Postgres via PostgREST (`packages/db/src/postgrest.js`). Migrations are numbered SQL in `packages/db/migrations`; apply them to Supabase by hand (Supabase MCP or dashboard) and commit the file.
- Hosting: Railway project "insyt" (web, worker, poller, cron, redis). Secrets live in Railway variables, never in the repo.

## Commands
- `npm test` (node:test, ~280 tests; the crawler e2e needs a Playwright chromium). `npm run lint:jargon`. `npm run build:client`.
- Deploy: append a line to `diagnostics/deploy-request.txt` and push to `main`; the `railway` workflow deploys all four services and commits `diagnostics/deploy-log.txt` (never use `[skip ci]` on a deploy request). Wait for the log before checking the live site.
- Push with `git push origin main` from this clone (credentials via `gh`). Never commit build output or secrets.

## Product rules (binding)
- Customer register: plain language, one action per screen, no jargon (container, snippet, property, conversion action, measurement id; enforced by the jargon linter on customer copy). Agency console (`client/src/agency`) is exempt.
- No em dashes anywhere (copy, comments, commits). British English in prose, American spelling only where the code already uses it.
- Never fabricate testimonials, logos, reviews or trust claims.
- Nothing is applied to a customer's Google account without an approval; builds are created paused; every applied change gets a 48-hour watch and one-tap undo.
- Gated platform: `locked` (no $20) / `unlocked` (paid) / `active` (plan). Reads are free at every level; writes that touch Google return 402 `plan_required` and the client opens the Plan sheet (`client/src/lib/access.jsx`, `plan-sheet.jsx`). Autopilot needs an Autopilot or Scale plan. Do not add a second paywall.
- Severity colours are the only hues in the app; dark is the default theme, light is its twin; both must keep working.
- Every screen needs loading, empty, error and degraded states with real copy; never leave placeholder elements.

## Accounts and safety
- The Nail DXB Google Ads account (591-194-9946) is a real live client: read-only, never approve, apply or trigger changes there. Test on JobPeak (642-459-6144) or the reviewer tenant.
- Stripe is the sandbox account until launch; test with card 4242 4242 4242 4242.
- Never paste keys, tokens or the Supabase service role key into code, commits or chat.

## Where things are decided
- Report anatomy and funnel: claude.ai project docs `frontend-strategy`, `gated-platform-spec`. Engine and rules: `engine-spec`. Marketing site (Webflow, site 6a82299ed632ca2caf5d5b6f) is edited through the Webflow connector in Cowork, not from this repo; publish to the custom domain only after Max reviews staging.
