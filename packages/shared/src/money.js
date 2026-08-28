// Money display + rough FX — one place for both.
// Amounts everywhere in the engine are in the AD ACCOUNT'S OWN currency
// (Google returns cost_micros in the account currency). These helpers make
// that visible ("AED 1,251", "$1,251") and give a rough USD view for the
// engine's USD-denominated guardrails and size bands. Rates are deliberately
// coarse (monthly-review material, §11) — never used for billing.
const SYMBOL = { USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', GBP: '£', EUR: '€' };
const TO_USD = {
  USD: 1, AED: 0.2723, SAR: 0.2666, QAR: 0.2747, KWD: 3.24, BHD: 2.65, OMR: 2.60,
  EUR: 1.09, GBP: 1.28, CAD: 0.73, AUD: 0.66, NZD: 0.61, CHF: 1.12,
  INR: 0.0115, PKR: 0.0036, EGP: 0.0207, TRY: 0.029, ZAR: 0.055,
  SGD: 0.75, HKD: 0.128, JPY: 0.0066, CNY: 0.14, MXN: 0.055, BRL: 0.18,
};

/** "AED 1,251" / "$1,251" / "€1,251". Whole units; sign preserved. */
function fmtMoney(amount, code = 'USD') {
  const c = String(code || 'USD').toUpperCase();
  const n = Math.round(Number(amount) || 0).toLocaleString('en-US');
  return SYMBOL[c] ? `${SYMBOL[c]}${n}` : `${c} ${n}`;
}

/** Rough USD equivalent for guardrails/size bands; unknown codes pass through. */
function toUsd(amount, code = 'USD') {
  const rate = TO_USD[String(code || 'USD').toUpperCase()];
  return (Number(amount) || 0) * (rate == null ? 1 : rate);
}

module.exports = { fmtMoney, toUsd, TO_USD };
