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

const tradeService = (trade) => (trade && TRADES[String(trade).toLowerCase()] ? TRADES[String(trade).toLowerCase()].service : null);

module.exports = { TRADES, tradeService };
