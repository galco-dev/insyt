# One image for all four Railway services (web, worker, poller, cron); the
# per-service start command is set in Railway and overrides CMD.
#
# Why a Dockerfile: the crawler (free check, live witness, tag-alive) runs
# headless Chromium via Playwright. Railpack's build step installed the
# browser but its system libraries never reached the runtime image, so every
# launch died with "libglib-2.0.so.0: cannot open shared object file". The
# official Playwright image carries the matching browser AND its libraries.
# Keep the tag in step with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

# Dev deps are needed for the client build (vite), then pruned.
RUN npm ci --include=dev --no-audit --no-fund \
 && npm run build:client \
 && npm prune --omit=dev

CMD ["npm", "run", "start:web"]
