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

  const n = v => Number(String(v == null ? '' : v).replace(/,/g, ''));
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
      const v = n(m.manualTola);
      return v > 0 ? { perGram: v / TOLA_G, date: m.manualDate || null, source: 'Your entered rate', stale: false } : null;
    }
    const x = data && data.metals && data.metals[metal];
    if (!x || !(x.pkr_gram > 0)) return null;
    const prem = n(m.premiumPct) || 0;
    return { perGram: x.pkr_gram * (1 + prem / 100), date: String(x.time || data.updated || '').slice(0, 10), source: x.source + (prem ? ` +${prem}%` : ''), stale: !!x.stale };
  }

  /**
   * Price per holding unit for a linked holding.
   * feedCfg: {type:'mufap', fund, field:'nav'|'repurchase'} | {type:'metal', metal:'gold'|'silver', karat} | {type:'fx', code} | {type:'crypto', coin}
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
    if (feedCfg.type === 'psx') {
      const q = data.psx && data.psx.items && data.psx.items[String(feedCfg.symbol || '').toUpperCase().trim()];
      if (!q || !(q.current > 0)) return null;
      return { price: q.current, date: data.psx.date, source: 'PSX close', stale: !!data.psx.stale, changePct: q.change_pct };
    }
    if (feedCfg.type === 'crypto') {   // USD price x the USD/PKR rate
      const c = data.crypto && data.crypto.usd && data.crypto.usd[String(feedCfg.coin || '').toUpperCase()], usd = data.fx && data.fx.pkr && data.fx.pkr.USD;
      if (!(c > 0) || !(usd > 0)) return null;
      return { price: c * usd, usd: c, date: String(data.crypto.time || data.updated || '').slice(0, 10), source: data.crypto.source + ' × USD/PKR', stale: !!(data.crypto.stale || data.fx.stale) };
    }
    if (feedCfg.type === 'fx') {
      const r = data.fx && data.fx.pkr && data.fx.pkr[feedCfg.code];
      if (!(r > 0)) return null;
      return { price: r, date: String(data.updated || '').slice(0, 10), source: data.fx.source, stale: !!data.fx.stale };
    }
    return null;
  }

  function psxList(data) {
    const items = (data && data.psx && data.psx.items) || {};
    return Object.keys(items).sort().map(s => ({ symbol: s, ...items[s] }));
  }

  function amcList(data) {
    const items = (data && data.funds && data.funds.items) || [];
    return [...new Set(items.map(f => f.amc || 'Other'))].sort((a, b) => a.localeCompare(b));
  }

  /** Decrypts data/psx.enc.json (AES-256-GCM, PBKDF2-SHA256) with the passphrase. Throws on a wrong key. */
  async function decryptDoc(doc, passphrase, subtle) {
    subtle = subtle || (root.crypto && root.crypto.subtle);
    const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', salt: unb64(doc.salt), iterations: doc.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(doc.iv) }, key, unb64(doc.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /** A fund's NAV on a date from the monthly NAV history files ({syms, days: {date: {c, o, r}}}): that day,
   *  else the last day before it, up to 10 days back. -> {date, nav, offer, repurchase} or null. */
  function navOn(months, name, date) {
    if (!months || !name || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
    const want = norm(name), earliest = new Date(Date.parse(date + 'T00:00:00Z') - 10 * 864e5).toISOString().slice(0, 10);
    for (const m of Object.keys(months).sort().reverse()) {
      const M = months[m];
      if (!M || !M.days || m > date.slice(0, 7) || m < earliest.slice(0, 7)) continue;
      const i = (M.syms || []).findIndex(x => norm(x) === want);
      if (i < 0) continue;
      for (const d of Object.keys(M.days).filter(x => x <= date && x >= earliest).sort().reverse()) {
        const D = M.days[d], c = D.c && D.c[i];
        if (c != null) return { date: d, nav: c, offer: D.o ? D.o[i] : null, repurchase: D.r ? D.r[i] : null };
      }
    }
    return null;
  }

  /** Holdings from the PSX & MUFAP dashboard (Day-Trader-PSX): its ledger.json, or what a backup holds.
   *  -> {holdings: [{name, cls, symbol, feed}], txns: [{holding, date, type, amount, units, note}], cash}
   *  Buys cost what they cost (price x shares + charges), sales bring what they brought (less charges);
   *  fund trades are the amount and units; dividends are income. Broker cash entries aren't investments
   *  here, so they're counted, not imported. */
  function fromPsxLedger(lg) {
    const r2 = x => Math.round(x * 100) / 100, out = { holdings: [], txns: [], cash: 0 }, seen = {};
    const hold = (name, cls, feed) => { if (!seen[name]) { seen[name] = 1; out.holdings.push({ name, cls, symbol: cls === 'psx' ? name : '', feed }); } };
    for (const e of (lg && lg.entries) || []) {
      const ch = (+e.commission || 0) + (+e.taxes || 0) + (+e.other || 0), note = e.note ? String(e.note) : '';
      if (e.type === 'buy' || e.type === 'sell') {
        const sym = String(e.symbol || '').toUpperCase(), gross = (+e.qty || 0) * (+e.price || 0);
        if (!sym || !gross) continue;
        hold(sym, 'psx', { type: 'psx', symbol: sym });
        out.txns.push({ holding: sym, date: e.date, type: e.type === 'buy' ? 'BUY' : 'SELL', amount: r2(e.type === 'buy' ? gross + ch : gross - ch), units: +e.qty,
          note: (note ? note + ' · ' : '') + `${e.qty} @ ${e.price}` + (ch ? `, charges ${r2(ch)}` : '') + (e.broker ? `, ${e.broker}` : '') });
      } else if (e.type === 'fund_buy' || e.type === 'fund_sell') {
        if (!e.fund || !(+e.amount)) continue;
        hold(e.fund, 'mf', { type: 'mufap', fund: e.fund });
        out.txns.push({ holding: e.fund, date: e.date, type: e.type === 'fund_buy' ? 'BUY' : 'SELL', amount: r2(+e.amount), units: +e.units || null,
          note: (note ? note + ' · ' : '') + (e.nav ? `NAV ${e.nav}` : '') });
      } else if (e.type === 'dividend') {
        const sym = String(e.symbol || '').toUpperCase();
        if (!sym || !(+e.net)) continue;
        hold(sym, 'psx', { type: 'psx', symbol: sym });
        out.txns.push({ holding: sym, date: e.date, type: 'INCOME', amount: r2(+e.net), units: null, note: note || 'dividend' });
      } else if (e.type === 'cash') out.cash++;
    }
    return out;
  }

  const api = { fromPsxLedger, navOn, decryptDoc, priceFor, metalPerGram, findFund, amcList, psxList, gramsPerUnit, TOLA_G, OZ_G };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Feed = api;
})(typeof self !== 'undefined' ? self : this);
