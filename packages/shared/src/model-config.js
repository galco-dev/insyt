// Model policy config — engine-spec §1. One env var picks the model; prices
// are config too so the §9.9 metering can cost every call. Defaults are the
// current Fable list prices (per million tokens); override in Railway when
// they change. Auto-upgrade is a gated config flip, never a silent switch.

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

module.exports = {
  MODEL_ID: process.env.INSYT_MODEL_ID || process.env.NARRATION_MODEL || 'claude-fable-5',
  MODEL_PRICE_IN_PER_MTOK: num(process.env.MODEL_PRICE_IN_PER_MTOK, 10),
  MODEL_PRICE_OUT_PER_MTOK: num(process.env.MODEL_PRICE_OUT_PER_MTOK, 50),
  // §9.9: included monthly allowance per tenant / agency seat, and the
  // heads-up point. Consent-card mechanics land with phase 5.
  USAGE_INCLUDED_USD: num(process.env.USAGE_INCLUDED_USD, 30),
  USAGE_HEADS_UP_PCT: num(process.env.USAGE_HEADS_UP_PCT, 80),
};
