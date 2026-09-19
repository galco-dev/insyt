const assert = require('node:assert');
const { test } = require('node:test');
const { TRADES, tradeService } = require('../src/trades');

test('every profession page on the marketing site maps to a service in plain words', () => {
  const pages = ['dentists', 'plumbers', 'roofers', 'hvac', 'electricians', 'landscapers', 'contractors', 'therapists', 'chiropractors', 'realestate'];
  for (const p of pages) assert.ok(TRADES[p] && TRADES[p].service, p);
  assert.equal(tradeService('Dentists'), 'Dentist');
  assert.equal(tradeService('real-estate-agents'), 'Real estate agent');
  assert.equal(tradeService('unknown'), null);
  assert.equal(tradeService(null), null);
});
