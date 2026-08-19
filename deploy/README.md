# Deploying Insyt — Railway (build-doc §15)

Four services from this one repo, plus a Redis addon. Each service sets
**Root Directory = repo root** and differs only in start command.

| Service  | Start command            | Notes |
|----------|--------------------------|-------|
| `web`    | `npm run start:web`      | Public. Attach domain `app.tryinsyt.com` (Cloudflare CNAME → Railway). Health: `/healthz`. |
| `worker` | `npm run start:worker`   | BullMQ consumer. Needs Playwright chromium: build command `npm ci && npx playwright install chromium --with-deps`. |
| `poller` | `npm run start:poller`   | Watches pump (tag-alive, 48h verify, first-conversion, journey polls). |
| `cron`   | `npm run start:cron`     | Sunday enqueue, deep-audit anniversaries, token sweep. |

Add the **Redis** addon; Railway injects `REDIS_URL`.

## Environment variables (set once per environment, staging + production)

```
SUPABASE_URL=            https://riwkekblrvarvfyqmdpq.supabase.co
SUPABASE_SERVICE_KEY=    (service role key — Supabase dashboard → API)
REDIS_URL=               (from the Railway Redis addon)
ANTHROPIC_API_KEY=       (org key with a monthly spend cap — master §15)
GOOGLE_CLIENT_ID=        (GCP OAuth web client)
GOOGLE_CLIENT_SECRET=
GOOGLE_ADS_DEVELOPER_TOKEN=   (when Basic access lands; test accounts until then)
STRIPE_SECRET_KEY=       (sk_test_… on staging; sk_live_… on production)
STRIPE_WEBHOOK_SECRET=   (from the Stripe webhook endpoint pointing at web /api/stripe/webhook)
RESEND_API_KEY=
SENTRY_DSN=
OPS_TOKEN=               (long random string — bearer auth for /ops)
APP_BASE_URL=            https://app.tryinsyt.com (staging: its own URL)
SESSION_SECRET=          (long random string — HMAC for magic-link sessions)
```

## Order of operations

1. Railway project → connect `galco-dev/insyt` → create the four services + Redis
   (or run the Actions workflow `railway` with the RAILWAY_TOKEN repo secret — it
   provisions everything and deploys via the Railway CLI).
2. Set env vars (staging first). Deploy. `web` `/healthz` should return `{ok:true}`.
3. Stripe: `STRIPE_SECRET_KEY=sk_test_… node scripts/seed-stripe.js` (22 objects), then
   create the webhook endpoint → paste signing secret into env.
4. Supabase → Auth → enable Google provider with the GCP client; add
   `APP_BASE_URL` to redirect allow-list.
5. Cloudflare: `app` CNAME → Railway target; Resend DNS (SPF/DKIM/DMARC) for
   `alerts.` and `mail.` subdomains BEFORE any send, then 2-week warm-up.
6. Production = same recipe, live keys, `tryinsyt.com` DNS.

Secrets live here and only here — never in the repo (§15).
