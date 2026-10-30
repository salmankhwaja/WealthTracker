/* zakat.js — pure Zakat calculation (no DOM). Works in browser and Node.
 *
 * Conventions (common Hanafi practice in Pakistan, as used by TCF and most calculators):
 *  - Nisab: gold 87.48 g (7.5 tola), silver 612.36 g (52.5 tola).
 *  - If all zakatable wealth is gold only, the gold nisab applies; for any mix, the
 *    (lower) silver nisab applies.
 *  - Rate 2.5% on net zakatable wealth held for one lunar year (hawl). If you track a
 *    Gregorian year instead, 2.5775% compensates for the longer year.
 *  - Net = zakatable assets − debts/bills due now.
 * This is a calculator, not a fatwa: users can override the basis and every percentage.
 */
(function (root) {
  'use strict';

  const GRAMS_PER_TOLA = 11.664;               // 87.48 g / 7.5 tola
  const NISAB_GRAMS = { gold: 87.48, silver: 612.36 };
  const RATE = { lunar: 0.025, solar: 0.025 * 365.2425 / 354.367 };

  const toGrams = (qty, unit) => (Number(qty) || 0) * (unit === 'tola' ? GRAMS_PER_TOLA : 1);
  const perGram = (price, unit) => (Number(price) || 0) / (unit === 'tola' ? GRAMS_PER_TOLA : 1);

  /**
   * @param {object} p
   *   goldRate, silverRate   price per `rateUnit` (PKR)
   *   rateUnit               'tola' | 'gram'
   *   basis                  'auto' | 'silver' | 'gold'
   *   calendar               'lunar' | 'solar'
   *   assets                 [{label, value, pct=100, kind:'gold'|'silver'|'other'}]  value in PKR
   *   liabilities            [{label, value}]
   *   deducted               Zakat already deducted at source (PKR)
   */
  function computeZakat(p) {
    const rateUnit = p.rateUnit === 'gram' ? 'gram' : 'tola';
    const g = perGram(p.goldRate, rateUnit), s = perGram(p.silverRate, rateUnit);
    const assets = (p.assets || []).map(a => {
      const pctv = a.pct == null || a.pct === '' ? 100 : Math.min(100, Math.max(0, Number(a.pct)));
      const value = Math.max(0, Number(a.value) || 0);
      return { ...a, value, pct: pctv, counted: value * pctv / 100 };
    }).filter(a => a.counted > 0);
    const liabilities = (p.liabilities || []).map(l => ({ ...l, value: Math.max(0, Number(l.value) || 0) })).filter(l => l.value > 0);

    const gross = assets.reduce((t, a) => t + a.counted, 0);
    const debts = liabilities.reduce((t, l) => t + l.value, 0);
    const net = Math.max(0, gross - debts);

    const onlyGold = assets.length > 0 && assets.every(a => a.kind === 'gold');
    let basisUsed = p.basis === 'gold' || p.basis === 'silver' ? p.basis : (onlyGold ? 'gold' : 'silver');
    const nisab = {
      gold: g > 0 ? NISAB_GRAMS.gold * g : null,
      silver: s > 0 ? NISAB_GRAMS.silver * s : null,
    };
    const nisabValue = nisab[basisUsed];
    const rate = RATE[p.calendar === 'solar' ? 'solar' : 'lunar'];
    const missingRate = nisabValue == null;
    const due = !missingRate && net >= nisabValue ? net * rate : 0;
    const deducted = Math.max(0, Number(p.deducted) || 0);
    const payable = Math.max(0, due - deducted);

    return {
      assets, liabilities, gross, debts, net, nisab, nisabValue, basisUsed, onlyGold, rate,
      missingRate, aboveNisab: !missingRate && net >= nisabValue, due, deducted, payable,
      goldPerGram: g, silverPerGram: s,
    };
  }

  const api = { computeZakat, toGrams, perGram, GRAMS_PER_TOLA, NISAB_GRAMS, RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Zakat = api;
})(typeof self !== 'undefined' ? self : this);
