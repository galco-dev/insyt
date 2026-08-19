#!/usr/bin/env node
// CLI: node cli.js <url> [--exe /path/to/chromium]
const { discoveryCrawl } = require('./src/crawl');
const { findingsStrip } = require('./src/findings-strip');

(async () => {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) { console.error('usage: cli.js <url> [--exe path]'); process.exit(1); }
  const exeIdx = args.indexOf('--exe');
  const opts = exeIdx > -1 ? { executablePath: args[exeIdx + 1] } : {};
  const result = await discoveryCrawl(url, opts);
  result.findings_strip = findingsStrip(result);
  console.log(JSON.stringify(result, null, 2));
})();
