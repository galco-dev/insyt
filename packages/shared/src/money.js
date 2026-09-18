// Money display, one place. Amounts everywhere in the engine are in the AD
// ACCOUNT'S OWN currency (Google returns cost_micros in it) and are never
// converted: the customer sees their own currency and nothing else.
const SYMBOL = { USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', GBP: '£', EUR: '€' };

/** "AED 1,251" / "$1,251" / "€1,251". Whole units; sign preserved. */
function fmtMoney(amount, code = 'USD') {
  const c = String(code || 'USD').toUpperCase();
  const n = Math.round(Number(amount) || 0).toLocaleString('en-US');
  return SYMBOL[c] ? `${SYMBOL[c]}${n}` : `${c} ${n}`;
}

module.exports = { fmtMoney };
