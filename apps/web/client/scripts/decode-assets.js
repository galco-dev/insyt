// Decodes base64-committed binary assets into public/ before the Vite build.
// Binaries can't travel through our text-only GitHub tooling, so they live
// in assets-src/*.b64 and materialise here at build time.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '../assets-src');
const out = path.join(__dirname, '../public');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.b64')) continue;
  const target = path.join(out, f.replace(/\.b64$/, ''));
  fs.writeFileSync(target, Buffer.from(fs.readFileSync(path.join(src, f), 'utf8').trim(), 'base64'));
  console.log('decoded', f, '→', target);
}
