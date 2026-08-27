#!/usr/bin/env node
// Emits the latest learning review as markdown (for the PR body) and the
// chosen tunings as JSON. Reads Supabase with the service key; never writes.
//   node scripts/learning/review.js [--month YYYY-MM-01] > review.md
const { createClient } = require('../../packages/db/src/postgrest');

async function main() {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY required'); process.exit(1); }
  const db = createClient({ url, serviceKey: key });
  const arg = process.argv.indexOf('--month');
  const month = arg > -1 ? process.argv[arg + 1] : null;
  const rows = await db.select('learning_reviews', month ? `month=eq.${month}&select=*` : 'select=*&order=month.desc&limit=1');
  const r = rows && rows[0];
  if (!r) { console.error('no learning review found'); process.exit(2); }
  process.stdout.write(r.body_md + '\n');
  require('fs').writeFileSync('learning-proposals.json', JSON.stringify(r.proposals, null, 2));
  console.error(`review ${r.month}: ${((r.proposals || {}).chosen || []).length} tunings, ${(r.incidents || []).length} incidents`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
