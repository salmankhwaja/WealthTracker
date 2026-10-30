// Run: node tests/feed.test.js
const assert = require('assert');
const FD = require('../feed.js');
const close = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
const data = {
  updated: '2026-10-30T07:20:00+00:00',
  fx: { source: 'x', pkr: { USD: 280 } },
  metals: { gold: { pkr_gram: 35000, time: '2026-10-30T07:00:00Z', source: 'gold-api.com' }, silver: { pkr_gram: 450, source: 'gold-api.com', time: '2026-10-30' } },
  funds: { latest_date: '2026-10-30', items: [{ fund: 'NBP Islamic Stock Fund & Co', amc: 'NBP', nav: 12.5, repurchase: 12.3, date: '2026-10-29' }] },
};
const spot = { gold: { source: 'spot' }, silver: { source: 'spot' }, navField: 'nav' };
// fund by name, case/entity insensitive
let p = FD.priceFor(data, { type: 'mufap', fund: 'nbp islamic stock fund &amp; co' }, 'units', spot);
close(p.price, 12.5); assert.strictEqual(p.date, '2026-10-29');
p = FD.priceFor(data, { type: 'mufap', fund: 'NBP Islamic Stock Fund & Co' }, 'units', { ...spot, navField: 'repurchase' });
close(p.price, 12.3);
assert.strictEqual(FD.priceFor(data, { type: 'mufap', fund: 'Missing' }, 'units', spot), null);
// gold per tola, 22K, with premium
p = FD.priceFor(data, { type: 'metal', metal: 'gold', karat: 22 }, 'tola', { ...spot, gold: { source: 'spot', premiumPct: 2 } });
close(p.price, 35000 * 1.02 * 11.664 * 22 / 24, 1e-4);
assert.strictEqual(p.date, '2026-10-30');
// manual gold rate per tola → per gram
p = FD.priceFor(data, { type: 'metal', metal: 'gold', karat: 24 }, 'gram', { ...spot, gold: { source: 'manual', manualTola: 466560 } });
close(p.price, 40000, 1e-6);
// unknown unit → null
assert.strictEqual(FD.priceFor(data, { type: 'metal', metal: 'gold' }, 'bars', spot), null);
// fx
close(FD.priceFor(data, { type: 'fx', code: 'USD' }, 'USD', spot).price, 280);
assert.deepStrictEqual(FD.amcList(data), ['NBP']);
console.log('All feed tests passed.');
