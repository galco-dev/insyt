// Railway `poller` service — build-doc §15.
// Drains due `watches` rows: tag-alive heartbeats, post-changeset 48h
// verification, first-click/first-conversion watches, and journey tag-install
// polls. Each watch kind has a handler; the poller is only the pump.
//
// handlers (injected): { [kind]: async (watch) -> { resolved?: bool, triggered?: bool, patch?: {} } }

const TICK_MS = 60_000;

async function tick({ store, handlers, now = Date.now() }) {
  const due = await store.dueWatches(new Date(now).toISOString());
  const actions = { checked: 0, triggered: 0, resolved: 0, errors: 0 };

  for (const watch of due) {
    const handler = handlers[watch.kind];
    if (!handler) continue;
    actions.checked += 1;
    try {
      const result = await handler(watch) || {};
      const patch = { last_check_at: new Date(now).toISOString(), ...(result.patch || {}) };
      if (result.triggered) {
        patch.status = 'triggered';
        patch.triggered_at = new Date(now).toISOString();
        actions.triggered += 1;
      } else if (result.resolved) {
        patch.status = 'resolved';
        actions.resolved += 1;
      }
      await store.patchWatch(watch.id, patch);
    } catch (err) {
      actions.errors += 1;
      // A broken watch never blocks the others; next tick retries it.
      await store.patchWatch(watch.id, { last_check_at: new Date(now).toISOString() }).catch(() => {});
    }
  }
  return actions;
}

function start(deps) {
  const timer = setInterval(() => {
    tick(deps).catch((err) => console.error('poller tick failed:', err.message));
  }, TICK_MS);
  return { stop: () => clearInterval(timer) };
}

module.exports = { tick, start, TICK_MS };

if (require.main === module) {
  console.error('poller service: supply store/handlers wiring before running standalone');
  process.exit(1);
}
