// Run: node tests/finance.test.js
const assert = require('assert');
const F = require('../finance.js');

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

// Microsoft's documented XIRR example → 0.373362535
close(F.xirr([
  { date: '2008-01-01', amount: -10000 },
  { date: '2008-03-01', amount: 2750 },
  { date: '2008-10-30', amount: 4250 },
  { date: '2009-02-15', amount: 3250 },
  { date: '2009-04-01', amount: 2750 },
]), 0.373362535, 1e-6);

// Lump sum doubling in exactly 365 days → 100%
close(F.xirr([{ date: '2021-01-01', amount: -100 }, { date: '2022-01-01', amount: 200 }]), 1.0);

// Loss case: -100 → 50 after a year → -50%
close(F.xirr([{ date: '2021-01-01', amount: -100 }, { date: '2022-01-01', amount: 50 }]), -0.5);

// Monthly SIP of 10,000 for 12 months, worth 130,000 at the end — positive return
const sip = [];
for (let m = 0; m < 12; m++) sip.push({ date: `2025-${String(m + 1).padStart(2, '0')}-01`, amount: -10000 });
sip.push({ date: '2026-01-01', amount: 130000 });
const r = F.xirr(sip);
assert.ok(r > 0.15 && r < 0.20, 'SIP xirr ' + r);

// No sign change → null
assert.strictEqual(F.xirr([{ date: '2021-01-01', amount: -100 }, { date: '2022-01-01', amount: -50 }]), null);

// Large gain (forces bracket expansion)
const big = F.xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-03-01', amount: 1000 }]);
assert.ok(big > 100, 'big ' + big);

// CAGR: 100 → 121 in 2 years = 10%
close(F.cagr(100, 121, 2), 0.1);

// CSV round-trip with commas, quotes and newlines
const rows = [{ a: 'x, y', b: 'he said "hi"' }, { a: 'line1\nline2', b: '3' }];
const back = F.parseCSV(F.toCSV(['a', 'b'], rows));
assert.deepStrictEqual(back, rows);

console.log('All finance tests passed. Example XIRR =', (F.xirr([
  { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 },
  { date: '2008-10-30', amount: 4250 }, { date: '2009-02-15', amount: 3250 },
  { date: '2009-04-01', amount: 2750 }]) * 100).toFixed(4) + '%');
