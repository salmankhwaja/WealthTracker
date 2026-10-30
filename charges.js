/* charges.js — estimated PSX brokerage, taxes and fees for a trade. Pure; browser and Node.
 *
 * Presets come from the Day-Trader-PSX project (brokers.json), which cites each tariff.
 * Commissions are negotiable and change: the figures on your contract note always win,
 * and the app lets you overwrite the computed amount.
 *
 * Model per trade at price P, quantity Q, value V = P × Q:
 *   commission = max(per_share × Q, pct% × V, min_commission)   using the first tier whose max_price ≥ P
 *   taxes      = sales_tax_pct% × commission (+ cvt_pct% × V on buys)
 *   other      = cdc_per_share × Q + levies_pct% × V              (CDC + PSX exchange fee + SECP levy)
 */
(function (root) {
  'use strict';
  const DEFAULTS = { sales_tax_pct: 13.0, cvt_pct: 0.0, cdc_per_share: 0.005, levies_pct: 0.00415 };
  const flat = (per_share, pct) => [{ max_price: null, per_share, pct }];
  const BROKERS = {
    'psx-minimum': { name: 'PSX regulatory minimum (0.15% or 3 paisa/share)', tiers: flat(0.03, 0.15) },
    finqalab: { name: 'Finqalab (Next Capital)', tiers: flat(0.03, 0.25) },
    akd: { name: 'AKD Securities (AKD Trade)', tiers: [{ max_price: 4.99, per_share: 0.03, pct: 0.15 }, { max_price: null, per_share: 0.05, pct: 0.15 }] },
    'arif-habib': { name: 'Arif Habib (AHL eTrade)', tiers: flat(0.03, 0.15) },
    'js-global': { name: 'JS Global (JS InvestPro)', tiers: flat(0.03, 0.15) },
    khanani: { name: 'MMK Trade (Khanani)', tiers: [{ max_price: 20, per_share: 0.03, pct: 0 }, { max_price: null, per_share: 0, pct: 0.15 }] },
    ktrade: { name: 'KTrade (KASB)', tiers: [{ max_price: 20, per_share: 0.03, pct: 0 }, { max_price: null, per_share: 0, pct: 0.15 }] },
    mra: { name: 'MRA Securities', tiers: flat(0.03, 0.15) },
    'next-capital': { name: 'Next Capital (direct)', tiers: flat(0.03, 0.15) },
    optimus: { name: 'Optimus (Optimus Trade)', tiers: flat(0.03, 0.15) },
    scs: { name: 'Standard Capital (SCS Trade)', tiers: [{ max_price: 10, per_share: 0.03, pct: 0 }, { max_price: null, per_share: 0.05, pct: 0.15 }] },
    sherman: { name: 'Sherman Securities', tiers: flat(0.03, 0.15) },
    topline: { name: 'Topline (Vtrade)', tiers: flat(0.03, 0.15) },
    none: { name: 'No charges (enter totals yourself)', tiers: flat(0, 0), zero: true },
  };

  const r2 = x => Math.round(x * 100) / 100;

  /** {commission, taxes, other, total, value, net} — net is cash paid (buy) or received (sell). */
  function tradeCharges(brokerKey, side, qty, price) {
    const b = BROKERS[brokerKey] || BROKERS['psx-minimum'];
    const q = Math.max(0, Number(qty) || 0), p = Math.max(0, Number(price) || 0), v = q * p;
    if (b.zero || !v) return { commission: 0, taxes: 0, other: 0, total: 0, value: r2(v), net: r2(v) };
    const tier = b.tiers.find(t => t.max_price == null || p <= t.max_price) || b.tiers[b.tiers.length - 1];
    const commission = Math.max(q * (tier.per_share || 0), v * (tier.pct || 0) / 100, b.min_commission || 0);
    let taxes = commission * DEFAULTS.sales_tax_pct / 100;
    if (side === 'buy') taxes += v * DEFAULTS.cvt_pct / 100;
    const other = q * DEFAULTS.cdc_per_share + v * DEFAULTS.levies_pct / 100;
    const total = commission + taxes + other;
    return { commission: r2(commission), taxes: r2(taxes), other: r2(other), total: r2(total), value: r2(v), net: r2(side === 'sell' ? v - total : v + total) };
  }

  const api = { tradeCharges, BROKERS, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Charges = api;
})(typeof self !== 'undefined' ? self : this);
