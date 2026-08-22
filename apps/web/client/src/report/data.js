// Sample audit - real-shaped, anonymized. This is the seed for the report
// screen and the public sample. Every number is internally consistent:
// verdicts follow from the stats on their own row, waste sums to the headline.
// Register: customer-facing strings use the plain-language register only
// (the CI jargon linter scans this whole tree).

export const audit = {
  business: 'Glow Studio',
  city: 'Dubai Marina',
  site: 'glowstudio.ae',
  date: '19 Aug 2026',
  type: 'Free audit',
  health: 58, // 0–100, engine-computed
  healthLabel: 'Needs attention',
  spend30d: 3840,
  wasteMonthly: 1240,
  counts: { critical: 2, warning: 3, info: 2 },

  findings: [
    {
      severity: 'critical',
      title: 'Every booking is being counted twice',
      money: null,
      body: 'Two of your counters fire on the same booking - one from your site, one imported from your analytics. Smart bidding is optimising toward numbers that are double the truth, so it bids on clicks that look profitable and are not.',
      fix: 'Keep the analytics count as the one that matters; demote the duplicate to observation-only. One change, reversible.',
    },
    {
      severity: 'critical',
      title: '$430 a month goes to searches that never book',
      money: null,
      body: 'Over 90 days, 11 recurring search themes - nail courses, salon jobs, DIY at-home kits - spent $1,290 and produced zero bookings. They match your ads because nobody has told Google to exclude them.',
      fix: 'Add 14 excluded searches. Your ads stop showing to bargain-hunters and job-seekers the same day.',
    },
    {
      severity: 'warning',
      title: 'One campaign is missing 38% of its chances',
      money: 'about $520 / month',
      body: 'Gel & Extensions runs out of budget by mid-afternoon most days. Google reports it misses 38% of the searches it could have shown for - and it is your cheapest source of bookings.',
      fix: 'Move $18/day from Generic - Nails (which books almost nothing) to Gel & Extensions. Same total spend, more bookings.',
    },
    {
      severity: 'warning',
      title: 'A 30-second page view is being counted like a booking',
      money: 'about $290 / month steered wrong',
      body: 'One of your counters treats “stayed 30 seconds” as a win. Smart bidding chases it, which drags budget toward browsers instead of bookers.',
      fix: 'Demote it to observation-only. Bidding re-centres on real bookings within a week.',
    },
    {
      severity: 'warning',
      title: 'Bookings made inside Instagram’s browser go uncounted',
      money: null,
      body: 'Roughly a fifth of your visits arrive through Instagram’s built-in browser, where your current setup loses track before the booking completes. Those bookings happen - they just never get credited to the ad that caused them.',
      fix: 'One setting change in how your tracking stores its session. We apply and verify it.',
    },
    {
      severity: 'info',
      title: 'Your history is kept for only 2 months',
      money: null,
      body: 'Your analytics deletes its detail after 2 months. Season-over-season comparisons - Ramadan, summer, December - are impossible with a 2-month memory.',
      fix: 'Extend retention to 14 months. Takes effect immediately, keeps everything from today forward.',
    },
    {
      severity: 'info',
      title: 'Credit for bookings is split by a default rule',
      money: null,
      body: 'When someone clicks an ad on Monday and books via Google search on Thursday, the credit is split by a default Google setting. Fine for now - worth revisiting once counting is clean.',
      fix: 'No action yet. We watch this after the fixes above settle.',
    },
  ],

  searchTerms: {
    total: 41,
    shown: 14,
    columns: ['Search', 'Campaign', 'Spend 90d', 'Clicks', 'Bookings', 'Cost/click', 'Verdict'],
    rows: [
      ['russian manicure dubai marina', 'Gel & Extensions', '$412', 188, 19, '$2.19', { v: 'promote', why: 'Your best search. Deserves its own ad + exact match.' }],
      ['gel extensions near me', 'Gel & Extensions', '$388', 176, 14, '$2.20', { v: 'keep', why: 'Booking steadily at $27.70 each. Leave it alone.' }],
      ['nail salon dubai marina', 'Generic - Nails', '$356', 149, 8, '$2.39', { v: 'keep', why: 'Books at $44.50 - acceptable for a broad search.' }],
      ['biab nails dubai', 'Gel & Extensions', '$247', 102, 9, '$2.42', { v: 'promote', why: 'Rising 3 months straight. Own ad group, exact match.' }],
      ['lash lift jbr', 'Lashes', '$204', 96, 6, '$2.13', { v: 'keep', why: 'Steady. Watch after budget rebalance.' }],
      ['nail courses dubai', 'Generic - Nails', '$231', 118, 0, '$1.96', { v: 'negative', why: 'Students, not clients. 118 clicks, zero bookings.' }],
      ['nail technician jobs dubai', 'Generic - Nails', '$187', 94, 0, '$1.99', { v: 'negative', why: 'Job-seekers. Exclude “jobs”, “salary”, “vacancy”.' }],
      ['cheap nails deira', 'Generic - Nails', '$164', 88, 1, '$1.86', { v: 'negative', why: 'Wrong area, wrong price point. One booking in 90 days.' }],
      ['how to do gel nails at home', 'Generic - Nails', '$139', 76, 0, '$1.83', { v: 'negative', why: 'DIY intent. Exclude “how to”, “at home”, “kit”.' }],
      ['press on nails amazon', 'Generic - Nails', '$118', 64, 0, '$1.84', { v: 'negative', why: 'Product shoppers, not salon clients.' }],
      ['acrylic nails price', 'Generic - Nails', '$102', 51, 2, '$2.00', { v: 'keep', why: 'Price-checkers do book - at $51 each. Borderline; keep 30 more days.' }],
      ['nail salon offers dubai', 'Generic - Nails', '$97', 49, 1, '$1.98', { v: 'keep', why: 'Low but not zero. Re-judge after negatives clean the pool.' }],
      ['gel nails removal near me', 'Gel & Extensions', '$88', 42, 3, '$2.10', { v: 'keep', why: 'Removal clients often convert to new sets.' }],
      ['best nail salon dubai', 'Generic - Nails', '$84', 38, 4, '$2.21', { v: 'promote', why: 'High-intent phrase booking at $21 - move to exact.' }],
    ],
  },

  keywords: {
    total: 23,
    shown: 10,
    columns: ['Keyword', 'Match', 'Spend 30d', 'Bookings', 'Cost per booking', 'vs account avg', 'Verdict'],
    accountAvgCpa: 31,
    rows: [
      ['gel extensions', 'phrase', '$310', 11, '$28.20', '−9%', { v: 'keep', why: 'Carrying the account. Protect its budget.' }],
      ['russian manicure', 'phrase', '$268', 10, '$26.80', '−14%', { v: 'keep', why: 'Best cost per booking you have.' }],
      ['nails dubai', 'broad', '$412', 6, '$68.70', '+122%', { v: 'rebid', why: 'Broad match is buying junk searches. Tighten to phrase, −30% bid.' }],
      ['nail salon', 'broad', '$296', 4, '$74.00', '+139%', { v: 'rebid', why: 'Same pattern. Phrase match + the new excluded list fixes most of it.' }],
      ['biab nails', 'phrase', '$187', 7, '$26.70', '−14%', { v: 'keep', why: 'Growing and cheap. Candidate for its own campaign (below).' }],
      ['lash lift', 'phrase', '$164', 5, '$32.80', '+6%', { v: 'keep', why: 'On par. Fine.' }],
      ['manicure pedicure dubai', 'phrase', '$142', 3, '$47.30', '+53%', { v: 'rebid', why: '−20% bid; re-check in 30 days.' }],
      ['nail art dubai', 'phrase', '$121', 1, '$121.00', '+290%', { v: 'pause', why: 'One booking in 30 days at 4× your average. Pause, keep the history.' }],
      ['eyelash extensions', 'phrase', '$118', 4, '$29.50', '−5%', { v: 'keep', why: 'Fine.' }],
      ['acrylic nails', 'phrase', '$104', 2, '$52.00', '+68%', { v: 'rebid', why: '−25% bid. Acrylic demand is real but overpriced at current position.' }],
    ],
  },

  campaigns: {
    columns: ['Campaign', 'Budget/day', 'Spend 30d', 'Bookings', 'Missed chances', 'Bidding', 'Verdict'],
    rows: [
      ['Gel & Extensions', '$40', '$1,214', 38, '38%', 'Maximise bookings', { v: 'keep', why: 'Your engine. Feed it - budget move below.' }],
      ['Brand - Glow Studio', '$12', '$318', 22, '2%', 'Maximise bookings', { v: 'keep', why: 'Cheap defence of your own name. Untouched.' }],
      ['Lashes', '$25', '$742', 16, '11%', 'Maximise bookings', { v: 'keep', why: 'Healthy. Re-check after counting is fixed.' }],
      ['Generic - Nails', '$52', '$1,566', 9, '0%', 'Maximise clicks', { v: 'restructure', why: 'Wrong goal (clicks, not bookings) + junk searches. Rebuild below.' }],
    ],
  },

  counting: {
    columns: ['What’s counted', 'Where it comes from', 'Counted 30d', 'Treated as', 'Verdict'],
    rows: [
      ['Booking confirmed', 'Your analytics', 118, 'A win', { v: 'keep', why: 'The one true count. Everything should optimise to this.' }],
      ['Book Now click', 'Your website', 121, 'A win', { v: 'demote', why: 'Same bookings, counted again - the double-count. Observation-only.' }],
      ['Phone call click', 'Your website', 34, 'A win', { v: 'keep', why: 'Real bookings start as calls. Keep.' }],
      ['Stayed 30 seconds', 'Your analytics', 902, 'A win', { v: 'demote', why: 'Browsing is not booking. This one drags bidding off-course.' }],
      ['WhatsApp click', 'Your website', 0, 'Observation', { v: 'retire', why: 'Counted nothing in 90 days - the button it watched was removed.' }],
    ],
  },

  tracking: {
    columns: ['Check', 'Status', 'Detail'],
    rows: [
      ['Tracking present on site', 'ok', 'Found on all 12 pages we crawled.'],
      ['Fires on every page', 'ok', 'Verified firing with the right ID.'],
      ['Booking page', 'gap', 'Your booking runs inside an embedded window (Fresha). The final “booked” step is invisible to your counter - bookings are inferred from the click before it.'],
      ['Instagram in-app browser', 'gap', 'Session is lost between tap and booking. Fixable with one storage setting.'],
      ['Thank-you confirmation', 'gap', 'No confirmation page exists, so counting leans on button clicks. The analytics import (kept above) is the honest source.'],
    ],
  },

  rebuild: {
    intro: 'Generic - Nails has the budget and the wrong shape: one ad group, broad match, optimising for clicks. Built again from your own 90 days of data:',
    campaigns: [
      {
        name: 'Nails - Exact Winners',
        budget: '$30/day',
        seed: 'Seeded from your 6 searches that already book under $30: russian manicure, biab nails, best nail salon dubai + 3 more.',
        why: 'Exact match on proven bookers. Expected cost per booking ~$24 based on their own 90-day history.',
      },
      {
        name: 'Nails - Phrase Discovery',
        budget: '$15/day',
        seed: 'Phrase-match versions of the winners + the full excluded list from day one.',
        why: 'Finds new searches like the winners without re-buying the junk the old campaign paid for.',
      },
    ],
    shared: 'Both start with the 14 excluded searches, bidding set to Maximise bookings, and the cleaned-up counting - so they learn from truth on day one. Old campaign pauses (never deleted): its history stays, and one tap restores it.',
  },

  unlock: {
    price: '$20',
    line: 'Unlock the full report - every row, every fix, ready to approve.',
    sub: '$20, credited to your first month if you subscribe - and refunded in full if the report tells you nothing useful. Nothing changes until you say so.',
  },
};

export const severityMeta = {
  critical: { label: 'Critical', color: 'critical' },
  warning: { label: 'Worth fixing', color: 'warning' },
  info: { label: 'Good to know', color: 'info' },
};

export const verdictMeta = {
  keep: { label: 'Keep', color: 'success' },
  promote: { label: 'Promote', color: 'info' },
  negative: { label: 'Exclude', color: 'critical' },
  rebid: { label: 'Rebid', color: 'warning' },
  pause: { label: 'Pause', color: 'warning' },
  demote: { label: 'Demote', color: 'warning' },
  retire: { label: 'Retire', color: 'critical' },
  restructure: { label: 'Rebuild', color: 'warning' },
};


// Deep sections - the paid tier's anatomy, sample-sized. Same discipline as
// the engine: measured figures come from the row data above; anything
// allocated rather than measured says modelled right on the chart.
export const deep = {
  moneyPicture: {
    modelled: true,
    xLabels: ['May', 'Jun', 'Jul', 'Aug 1-12', 'Aug 13-20'],
    actual: [3100, 3580, 5400, 2720, 1810],
    optimized: [2670, 3100, 4710, 2380, 1560],
    saved: [430, 480, 690, 340, 250],
  },
  cpaCurve: {
    xLabels: ['May', 'Jun', 'Jul', 'Aug 1-12', 'Aug 13-20'],
    values: [66, 38, 31, 30, 48],
    floor: 30,
    regressionAt: 4,
    note: 'The jump tracks the 13 Aug counting fix; ads are relearning toward the floor.',
  },
  leakLedger: {
    rows: [
      { label: 'Gel + BIAB', segments: [
        { kind: 'recovered', label: 'Recovered', value: 288 },
        { kind: 'calendar', label: 'Calendar waste', value: 0 },
        { kind: 'active', label: 'Still bleeding', value: 331 },
      ] },
      { label: 'Lashes', segments: [
        { kind: 'recovered', label: 'Recovered', value: 197 },
        { kind: 'calendar', label: 'Calendar waste', value: 274 },
        { kind: 'active', label: 'Still bleeding', value: 520 },
      ] },
      { label: 'Brows', segments: [
        { kind: 'recovered', label: 'Recovered', value: 173 },
        { kind: 'calendar', label: 'Calendar waste', value: 250 },
        { kind: 'active', label: 'Still bleeding', value: 389 },
      ] },
    ],
    sub: 'Green is already recovered, gray is calendar waste, red is still bleeding. The red column adds up to the headline number.',
  },
  qs: {
    avg: 3.9,
    premiumMonthly: 760,
    bins: [
      { label: 'QS 1', count: 2, status: 'critical' },
      { label: 'QS 2', count: 3, status: 'critical' },
      { label: 'QS 3', count: 8, status: 'critical' },
      { label: 'QS 4', count: 5, status: 'warning' },
      { label: 'QS 5', count: 5, status: 'warning' },
      { label: 'QS 6', count: 3, status: 'success' },
      { label: 'QS 7', count: 2, status: 'success' },
    ],
    sub: 'Google rates every search\'s fit from 1 to 10 and prices clicks by it. Most of your spend sits in the red bins, paying up to twice per click for the same position.',
  },
  hours: {
    flagged: [5, 8],
    rows: [
      { hour: 0, spend: 86, cpa: 32 }, { hour: 1, spend: 68, cpa: 38 }, { hour: 2, spend: 60, cpa: null },
      { hour: 3, spend: 88, cpa: null }, { hour: 4, spend: 20, cpa: 28 }, { hour: 5, spend: 19, cpa: 95 },
      { hour: 6, spend: 40, cpa: 30 }, { hour: 7, spend: 52, cpa: 24 }, { hour: 8, spend: 90, cpa: 74 },
      { hour: 9, spend: 62, cpa: 40 }, { hour: 10, spend: 112, cpa: 33 }, { hour: 11, spend: 111, cpa: 28 },
      { hour: 12, spend: 108, cpa: 25 }, { hour: 13, spend: 104, cpa: 22 }, { hour: 14, spend: 122, cpa: 44 },
      { hour: 15, spend: 103, cpa: 38 }, { hour: 16, spend: 108, cpa: 30 }, { hour: 17, spend: 78, cpa: 41 },
      { hour: 18, spend: 94, cpa: 50 }, { hour: 19, spend: 71, cpa: 36 }, { hour: 20, spend: 70, cpa: 27 },
      { hour: 21, spend: 56, cpa: 22 }, { hour: 22, spend: 52, cpa: 25 }, { hour: 23, spend: 46, cpa: 20 },
    ],
    sub: 'Two hours pay a multiple of your usual price per result. Excluding them keeps every other hour running.',
  },
  headroom: {
    rows: [
      { label: 'Brows', pct: 24.2 },
      { label: 'Gel + BIAB', pct: 10.7 },
      { label: 'Lashes', pct: 10.0 },
    ],
    metrics: {
      columns: ['Measure', 'Gel + BIAB', 'Lashes', 'Brows', 'Reading'],
      rows: [
        ['Share of interested clicks won', '10.7%', '10.0%', '24.2%', 'The market holds roughly ten times today\'s volume'],
        ['Views lost to the budget cap', '22.9%', '20.7%', '19.9%', 'A fifth of interested views missed while results ran on target'],
        ['Filtered suspicious clicks', '5.5%', '9.5%', '12.9%', 'Not billed; Brows is near the alarm band, watch monthly'],
      ],
    },
    sub: 'The share of interested clicks you win today. The rest of the market is reachable at a measured pace, at the efficiency you already have.',
  },
  conversionMix: [
    { signal: 'WhatsApp taps', count: 44, share: 36, note: 'Primary booking route' },
    { signal: 'Online bookings', count: 21, share: 17, note: 'Via your booking page' },
    { signal: 'Phone calls', count: 2, share: 2, note: 'Rare by customer habit' },
    { signal: 'Direction requests', count: 56, share: 46, note: 'Soft walk-in intent, counted separately on purpose' },
  ],
  copyAssets: {
    columns: ['Ad wording', 'Type', 'Views', 'Status', 'What it tells us'],
    rows: [
      ['"Russian Manicure From $45"', 'Headline', '1,489', 'good', 'Your most-served line. Service plus price is the proven formula'],
      ['"20% Off First Booking"', 'Headline', '1,711', 'good', 'The offer angle Google picks second, everywhere'],
      ['"Gel + BIAB $68"', 'Headline', '814', 'good', 'Carries its group; the group books at your average'],
      ['"Book On WhatsApp"', 'Headline', '165', 'watch', 'Missing from your three newest ads; add it back'],
      ['"Lash Lift + Tint $68"', 'Headline', '344', 'good', 'Earning placement since the rewrite'],
      ['"Brow Lamination From $40"', 'Headline', 'serving', 'serious', 'The website says $68. Same-day wording fix'],
      ['"One session, 6-8 weeks of lift"', 'Description', '452', 'good', 'Your best description; keep it everywhere'],
      ['"Walk-ins welcome, DIFC, 5 min"', 'Description', '386', 'good', 'Location proof works with the price lines'],
    ],
  },
  register: {
    sub: 'Each change is itemised, reversible, and applied only after your approval. This is the record a handover-ready account keeps.',
    columns: ['ID', 'Change', 'Exact item', 'Why', 'Status'],
    rows: [
      ['G-01', 'Pause search', '"manicure near me" (exact)', 'Lowest quality rating, zero bookings, priciest clicks', 'Applied · verified 18 Aug'],
      ['G-02', 'Exclude searches', '14 competitor salon names', 'Browsers, not bookers; zero bookings across 90 days', 'Applied · verified 18 Aug'],
      ['G-03', 'Add search', '"Russian manicure" (exact)', 'Real demand arriving through the side door', 'Applied · verified 18 Aug'],
      ['L-01', 'Exclude searches', '"acrylic", "dip nails" and 3 more', 'Services not on your menu', 'Applied · verified 18 Aug'],
      ['L-02', 'Fix wording', 'Typo in your newest lash ad', 'Live on 100+ search pages', 'Waiting for your yes'],
      ['B-01', 'Fix wording', '"Brow Lamination From $40" to $68', 'The website price is $68; price-intent clicks arrive on a wrong promise', 'Waiting for your yes'],
      ['B-02', 'Exclude hours', '05:00-06:00 account-wide', 'Money hours analysis above', 'Waiting for your yes'],
      ['B-03', 'Exclude day', 'Tuesday, Brows only', 'Costs five times what Friday costs, lifetime', 'Waiting for your yes'],
      ['A-01', 'Demote counter', 'Direction requests to secondary', 'Softer signal; cleaner target for smart bidding', 'Waiting for your yes'],
      ['A-02', 'Remove dead links', '18 never-served extras under your ads', 'Dead inventory, one had a typo on 95 search pages', 'Applied · verified 18 Aug'],
    ],
  },
  unexamined: [
    'Age and gender breakdown - offered, not yet pulled; out-of-audience spend would be free waste removal',
    'How long bookings take to land - calibrates whether young results are read too early',
    'Account change history - would confirm authorship of every change we did not make',
    'Seasonal patterns - needs a longer history; revisit quarterly',
  ],
};
