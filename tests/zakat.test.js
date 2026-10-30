// Run: node tests/zakat.test.js
const assert = require('assert');
const Z = require('../zakat.js');
const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

// Nisab in tola matches the grams definition
close(Z.NISAB_GRAMS.gold / Z.GRAMS_PER_TOLA, 7.5, 1e-9);
close(Z.NISAB_GRAMS.silver / Z.GRAMS_PER_TOLA, 52.5, 1e-9);

// Mixed assets → silver nisab, 2.5%
let r = Z.computeZakat({
  rateUnit: 'gram', goldRate: 39000, silverRate: 500, basis: 'auto',
  assets: [{ label: 'Bank', value: 1000000 }, { label: 'Gold', value: 400000, kind: 'gold' }],
  liabilities: [{ label: 'Bills', value: 100000 }],
});
assert.strictEqual(r.basisUsed, 'silver');
close(r.nisabValue, 612.36 * 500);
close(r.net, 1300000);
close(r.due, 32500);

// Only gold → gold nisab; 5 tola of gold is below 7.5 tola nisab → nothing due
const tolaRate = 39000 * Z.GRAMS_PER_TOLA;
r = Z.computeZakat({ rateUnit: 'tola', goldRate: tolaRate, silverRate: 500 * Z.GRAMS_PER_TOLA,
  assets: [{ label: 'Jewellery', value: 5 * tolaRate, kind: 'gold' }] });
assert.strictEqual(r.basisUsed, 'gold');
assert.strictEqual(r.aboveNisab, false);
assert.strictEqual(r.due, 0);

// Partial percentage (e.g. shares) and deduction at source
r = Z.computeZakat({ rateUnit: 'gram', goldRate: 39000, silverRate: 500,
  assets: [{ label: 'Shares', value: 1000000, pct: 40 }, { label: 'Cash', value: 600000 }], deducted: 15000 });
close(r.gross, 1000000);
close(r.due, 25000);
close(r.payable, 10000);

// Debts larger than assets → zero, never negative
r = Z.computeZakat({ rateUnit: 'gram', goldRate: 39000, silverRate: 500,
  assets: [{ label: 'Cash', value: 100 }], liabilities: [{ label: 'Loan', value: 500 }] });
assert.strictEqual(r.net, 0); assert.strictEqual(r.due, 0);

// Missing silver rate → flagged, no zakat computed
r = Z.computeZakat({ rateUnit: 'gram', goldRate: 39000, assets: [{ label: 'Cash', value: 5e6 }] });
assert.strictEqual(r.missingRate, true);

// Gregorian year rate ≈ 2.5775%
r = Z.computeZakat({ rateUnit: 'gram', silverRate: 500, calendar: 'solar', assets: [{ label: 'Cash', value: 1e6 }] });
close(r.rate, 0.025775, 0.00002);

console.log('All zakat tests passed.');
