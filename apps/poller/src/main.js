// Railway `poller` service bootstrap. Watch handlers arrive with the §9
// cascade wiring; until then the pump runs with an empty handler set —
// due watches are simply left untouched (never falsely resolved).

const { createClient } = require('../../../packages/db/src/postgrest');
const { opsStore } = require('../../../packages/db/src/stores');
const { start } = require('./service');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

const db = createClient({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_KEY') });
const ops = opsStore(db);

start({
  store: { dueWatches: ops.dueWatches, patchWatch: ops.patchWatch },
  handlers: {}, // tag_alive / changeset_verify / first_conversion land with §9 wiring
});
console.log('poller running (no handlers wired yet — watches accumulate untouched)');
