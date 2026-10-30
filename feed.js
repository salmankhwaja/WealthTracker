/* feed.js — turns data/prices.json into a price for a holding. Pure (no DOM); works in browser and Node. */
(function (root) {
  'use strict';
  const TOLA_G = 11.664, OZ_G = 31.1034768;

  /** grams in one holding unit (tola / gram / ounce / kg) */
  function gramsPerUnit(unit) {
    const u = String(unit || '').toLowerCase().trim();
    if (/tola/.test(u)) return TOLA_G;
    if (/^(oz|ounce|troy)/.test(u)) return OZ_G;
    if (/^kg|kilo/.test(u)) return 1000;
    if (/^(g|gm|gms|gram|grams)$/.test(u)) return 1;
    return null;
  }

  const norm = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  function findFund(data, name) {
    const items = data && data.funds && data.funds.items;
    if (!items || !name) return null;
    const n = norm(name);
    return items.find(f => norm(f.fund) === n) || null;
  }

  /** PKR per gram of a metal at 24K (gold) or pure (silver) under the user's market settings. */
  function metalPerGram(data, metal, market) {
    const m = (market && market[metal]) || {};
    if (m.source === 'manual') {
      const v = Number(m.manualTola);
      return v > 0 ? { perGram: v / TOLA_G, date: m.manualDate || null, source: 'Your entered rate', stale: false } : null;
    }
    const x = data && data.metals && data.metals[metal];
    if (!x || !(x.pkr_gram > 0)) return null;
    const prem = Number(m.premiumPct) || 0;
    return { perGram: x.pkr_gram * (1 + prem / 100), date: String(x.time || data.updated || '').slice(0, 10), source: x.source + (prem ? ` +${prem}%` : ''), stale: !!x.stale };
  }

  /**
   * Price per holding unit for a linked holding.
   * feedCfg: {type:'mufap', fund, field:'nav'|'repurchase'} | {type:'metal', metal:'gold'|'silver', karat} | {type:'fx', code}
   * Returns {price, date, source, stale} or null when unavailable.
   */
  function priceFor(data, feedCfg, unit, market) {
    if (!data || !feedCfg) return null;
    if (feedCfg.type === 'mufap') {
      const f = findFund(data, feedCfg.fund);
      if (!f) return null;
      const field = (market && market.navField) || 'nav';
      const price = field === 'repurchase' && f.repurchase ? f.repurchase : f.nav;
      return { price, date: f.date || data.funds.latest_date, source: 'MUFAP ' + (field === 'repurchase' && f.repurchase ? 'repurchase price' : 'NAV'), stale: !!data.funds.stale };
    }
    if (feedCfg.type === 'metal') {
      const g = gramsPerUnit(unit);
      const base = metalPerGram(data, feedCfg.metal, market);
      if (!g || !base) return null;
      const purity = feedCfg.metal === 'gold' ? (Number(feedCfg.karat) || 24) / 24 : 1;
      return { price: base.perGram * g * purity, date: base.date, source: base.source, stale: base.stale };
    }
    if (feedCfg.type === 'fx') {
      const r = data.fx && data.fx.pkr && data.fx.pkr[feedCfg.code];
      if (!(r > 0)) return null;
      return { price: r, date: String(data.updated || '').slice(0, 10), source: data.fx.source, stale: !!data.fx.stale };
    }
    return null;
  }

  function amcList(data) {
    const items = (data && data.funds && data.funds.items) || [];
    return [...new Set(items.map(f => f.amc || 'Other'))].sort((a, b) => a.localeCompare(b));
  }

  const api = { priceFor, metalPerGram, findFund, amcList, gramsPerUnit, TOLA_G, OZ_G };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Feed = api;
})(typeof self !== 'undefined' ? self : this);
