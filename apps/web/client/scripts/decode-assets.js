// Pre-build asset step: renders the OG share card (public/og.png) with the
// Playwright Chromium that the deploy image installs for the crawler. Binary
// assets can't travel through our text-only GitHub tooling, so the card is
// authored as HTML here and rasterised at build time. If Chromium is missing
// (e.g. a bare dev checkout), the build continues without the card.
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '../public');
const CARD = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #0a0a0c; color: #fff;
         font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif;
         padding: 70px 80px; display: flex; flex-direction: column; }
  .brand { font-family: ui-monospace, 'Courier New', monospace; font-size: 26px;
           letter-spacing: 0.35em; color: #7a8b94; }
  h1 { margin-top: 44px; font-size: 82px; line-height: 1.08; letter-spacing: -0.02em;
       font-weight: 700; max-width: 20ch; }
  .trust { margin-top: 40px; font-size: 27px; color: #9fb0b8; }
  .rows { margin-top: 34px; display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; align-items: center; gap: 18px; font-size: 22px; color: #c8d2d8; }
  .chip { width: 13px; height: 26px; border-radius: 4px; flex: none; }
</style></head><body>
  <div class="brand">INSYT</div>
  <h1>Your Google Ads, watched and fixed every week.</h1>
  <div class="trust">Free check &middot; 3 minutes &middot; read-only &middot; no email needed</div>
  <div class="rows">
    <div class="row"><span class="chip" style="background:#DC2626"></span>$430/mo goes to searches that never book</div>
    <div class="row"><span class="chip" style="background:#D97706"></span>One campaign is missing 38% of its chances</div>
    <div class="row"><span class="chip" style="background:#16A34A"></span>Fixed &mdash; 14 searches excluded, verified for 48h</div>
  </div>
</body></html>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { console.log('og card: playwright not installed, skipping'); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log('og card: no browser available, skipping —', e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(CARD, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(OUT, 'og.png') });
    console.log('og card: rendered → public/og.png');
  } finally { await browser.close(); }
}

main().catch((e) => { console.log('og card: skipped —', e.message.split('\n')[0]); });
