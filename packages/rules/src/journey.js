// Journey rules — engine-spec §3.3 / §5.1. The Journey B/C setup checklist
// as findings, not a separate system: a first-time advertiser sees "what is
// left before your ads can run", each step with who does it (mostly us).
//
// ctx.setup = { journey: 'A'|'B'|'C', gates: { tag, billing, approval }, linked: ['ads_account', ...] }

const rules = [
  {
    rule_id: 'journeyB.setup_incomplete',
    layer: 6,
    run({ setup }) {
      if (!setup || setup.journey === 'A') return [];
      const linked = new Set(setup.linked || []);
      const gates = setup.gates || {};
      const steps = [];
      if (!linked.has('ga4_property')) steps.push({ value: 'Visit tracking', detail: 'We create it for you.', by: 'insyt' });
      if (!linked.has('gtm_container')) steps.push({ value: 'Tracking code on your site', detail: 'We place it where your website builder allows; otherwise a picture guide.', by: 'insyt' });
      else if (gates.tag === false) steps.push({ value: 'Tracking code seen live', detail: 'We check your site every few minutes and tell you the moment it is there.', by: 'insyt' });
      if (gates.billing === false) steps.push({ value: 'Ad money connected to Google', detail: 'One step in Google Ads; we send the link.', by: 'you' });
      if (!steps.length) return [];
      return [{
        category: 'setup',
        entity_key: 'journey:setup',
        severity_override: 'warning',
        money: { impact_monthly_usd: 0, direction: 'waste', confidence: 'none' },
        evidence: { metrics: { steps_left: steps.length, journey: setup.journey }, window_days: 0, queries: ['journey/setup_incomplete@v1'] },
        payload: {
          locked: false,
          entities: steps.map((s) => ({ kind: 'setup_step', value: s.value, detail: s.detail, by: s.by })),
          fix_detail: `${steps.length} step${steps.length === 1 ? '' : 's'} left before your ads can run. We do ${steps.filter((s) => s.by === 'insyt').length} of them; your campaign draft is ready and waits behind this list.`,
        },
        icon: 'list',
      }];
    },
  },
];

module.exports = { rules };
