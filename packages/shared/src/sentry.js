// Minimal Sentry reporter — §15 monitoring line, no SDK dependency.
// Parses the DSN, posts store-API events, hooks process-level failures.

function parseDsn(dsn) {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(dsn || '');
  if (!m) return null;
  return { key: m[1], host: m[2], projectId: m[3] };
}

function init({ dsn = process.env.SENTRY_DSN, service, fetchImpl = fetch } = {}) {
  const cfg = parseDsn(dsn);
  const capture = async (err, level = 'error') => {
    if (!cfg) return;
    try {
      await fetchImpl(`https://${cfg.host}/api/${cfg.projectId}/store/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${cfg.key}, sentry_client=insyt/0.1`,
        },
        body: JSON.stringify({
          level,
          platform: 'node',
          logger: service,
          timestamp: Date.now() / 1000,
          message: String(err && err.message ? err.message : err).slice(0, 1000),
          extra: { stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined, service },
        }),
      });
    } catch { /* monitoring must never take the service down */ }
  };

  process.on('uncaughtException', (err) => { capture(err).finally(() => { console.error(err); process.exit(1); }); });
  process.on('unhandledRejection', (err) => { capture(err, 'warning'); console.error('unhandledRejection:', err); });
  if (cfg) console.log(`sentry reporting active (${service})`);
  return { capture };
}

module.exports = { init, parseDsn };
