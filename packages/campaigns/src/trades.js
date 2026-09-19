// The ten profession pages on the marketing site send `trade=` with the
// check (tracking brief). Each maps to the service a first ad should be
// found for, in the customer's own words. Anything else falls back to the
// service the customer types on the first-ad screen.
const TRADES = {
  dentists: { label: 'Dentists', service: 'Dentist' },
  plumbers: { label: 'Plumbers', service: 'Plumber' },
  roofers: { label: 'Roofers', service: 'Roof repair' },
  hvac: { label: 'Heating and cooling', service: 'Air conditioning repair' },
  electricians: { label: 'Electricians', service: 'Electrician' },
  landscapers: { label: 'Landscapers', service: 'Landscaping' },
  contractors: { label: 'Contractors', service: 'Home renovation' },
  therapists: { label: 'Therapists', service: 'Therapist' },
  chiropractors: { label: 'Chiropractors', service: 'Chiropractor' },
  realestate: { label: 'Real estate', service: 'Real estate agent' },
};

// The pages send the trade as their slug (dentists, hvac, real-estate-agents);
// letters only, lower case, with the page names that differ from the keys.
const ALIASES = { realestateagents: 'realestate', realestateagent: 'realestate', estateagents: 'realestate', hvacs: 'hvac' };
function tradeService(trade) {
  if (!trade) return null;
  const k = String(trade).toLowerCase().replace(/[^a-z]/g, '');
  const key = TRADES[k] ? k : ALIASES[k];
  return key && TRADES[key] ? TRADES[key].service : null;
}

module.exports = { TRADES, tradeService };
