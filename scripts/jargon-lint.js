#!/usr/bin/env node
// Jargon linter — master-doc §4.3 / build-doc §12, CI-enforced.
// Fails the build if any customer-facing string file contains blocklisted jargon.
// Scope: email templates and app copy. Code, SQL and internal docs are exempt.

const fs = require('fs');
const path = require('path');

const BLOCKLIST = [
  /\bcontainers?\b/i,
  /\bsnippets?\b/i,
  /\bproperty\b/i, // GA4 sense; copy should say "your tracking"
  /\bconversion actions?\b/i,
  /\bmeasurement id\b/i,
];

// Only these trees hold customer-facing copy.
const COPY_GLOBS = ['apps/web/copy', 'apps/worker/templates', 'packages/emails', 'apps/web/client/src'];

// Agency surfaces invert the register (master §4.3): full technical
// vocabulary internally, so the blocklist does not apply there.
const EXEMPT = [path.join('apps', 'web', 'client', 'src', 'agency')];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (EXEMPT.some((e) => p.includes(e))) continue;
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(json|html|txt|mdx?|tsx?|jsx?)$/.test(entry.name)) yield p;
  }
}

let failures = 0;
for (const root of COPY_GLOBS) {
  for (const file of walk(path.join(process.cwd(), root))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of BLOCKLIST) {
      const m = re.exec(text);
      if (m) {
        console.error(`JARGON: "${m[0]}" in ${file}`);
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} jargon violation(s). The register is the product — fix the copy.`);
  process.exit(1);
}
console.log('jargon-lint: clean');
