// Run: node tests/charges.test.js
const assert = require('assert');
const C = require('../charges.js');
const close = (a, b, t = 0.011) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);

// 1,000 OGDC @ 250 via PSX minimum: 0.15% of 250,000 = 375 > 30 (3 paisa x 1000)
let c = C.tradeCharges('psx-minimum', 'buy', 1000, 250);
close(c.commission, 375); close(c.taxes, 48.75);                 // 13% SST
close(c.other, 1000 * 0.005 + 250000 * 0.00415 / 100);           // CDC + levies = 5 + 10.375
close(c.net, 250000 + c.total); assert.strictEqual(c.value, 250000);

// Penny stock: per-share floor wins (3 paisa x 10,000 = 300 > 0.15% x 20,000 = 30)
c = C.tradeCharges('psx-minimum', 'buy', 10000, 2);
close(c.commission, 300);

// Finqalab 0.25%, sell → net is value minus charges
c = C.tradeCharges('finqalab', 'sell', 100, 1000);
close(c.commission, 250); close(c.net, 100000 - c.total);

// Tiered broker (AKD): price 4.5 uses tier 1, price 10 uses tier 2 (5 paisa)
close(C.tradeCharges('akd', 'buy', 100000, 4.5).commission, Math.max(3000, 450000 * 0.0015));
close(C.tradeCharges('akd', 'buy', 100000, 10).commission, Math.max(5000, 1000000 * 0.0015));

// "none" preset and zero quantity
assert.strictEqual(C.tradeCharges('none', 'buy', 10, 10).total, 0);
assert.strictEqual(C.tradeCharges('finqalab', 'buy', 0, 10).total, 0);
console.log('All charges tests passed.');
