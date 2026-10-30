/* finance.js — pure calculation helpers (no DOM). Works in browser and Node. */
(function (root) {
  'use strict';
  const DAY = 86400000;

  function toTime(d) {
    if (typeof d === 'number') return d;
    const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, dd);
  }

  function yearsBetween(a, b) {
    return (toTime(b) - toTime(a)) / (365 * DAY);
  }

  /** Net present value with irregular dates (Excel XNPV convention, 365-day year). */
  function xnpv(rate, flows) {
    const t0 = flows[0].t;
    let s = 0;
    for (const f of flows) s += f.amount / Math.pow(1 + rate, (f.t - t0) / (365 * DAY));
    return s;
  }

  function dxnpv(rate, flows) {
    const t0 = flows[0].t;
    let s = 0;
    for (const f of flows) {
      const e = (f.t - t0) / (365 * DAY);
      s += (-e * f.amount) / Math.pow(1 + rate, e + 1);
    }
    return s;
  }

  /**
   * XIRR: annualised internal rate of return for dated cash flows.
   * flows: [{date:'YYYY-MM-DD', amount:Number}] — money you put in is negative,
   * money you get back (sales, dividends, current value) is positive.
   * Returns a decimal (0.15 = 15%) or null when no solution exists.
   */
  function xirr(input, guess) {
    const flows = input
      .filter(f => f && isFinite(f.amount) && f.amount !== 0)
      .map(f => ({ t: toTime(f.date), amount: Number(f.amount) }))
      .sort((a, b) => a.t - b.t);
    if (flows.length < 2) return null;
    if (!flows.some(f => f.amount > 0) || !flows.some(f => f.amount < 0)) return null;
    if (flows[flows.length - 1].t === flows[0].t) return null;

    // 1) Newton–Raphson
    let r = guess == null ? 0.1 : guess;
    for (let i = 0; i < 100; i++) {
      const v = xnpv(r, flows);
      const d = dxnpv(r, flows);
      if (!isFinite(v) || !isFinite(d) || d === 0) break;
      const next = r - v / d;
      if (next <= -0.999999999) break;
      if (Math.abs(next - r) < 1e-10) return next;
      r = next;
    }

    // 2) Bisection fallback on a bracket that contains a sign change
    let lo = -0.9999, hi = 1;
    let flo = xnpv(lo, flows), fhi = xnpv(hi, flows);
    let guard = 0;
    while (flo * fhi > 0 && guard++ < 60) {
      hi *= 2;
      fhi = xnpv(hi, flows);
      if (!isFinite(fhi)) return null;
    }
    if (flo * fhi > 0) return null;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2;
      const fm = xnpv(mid, flows);
      if (Math.abs(fm) < 1e-9 || (hi - lo) / 2 < 1e-12) return mid;
      if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /** CAGR between a start value and an end value over `years`. */
  function cagr(start, end, years) {
    if (!(start > 0) || !(end >= 0) || !(years > 0)) return null;
    return Math.pow(end / start, 1 / years) - 1;
  }

  // ---------- CSV ----------
  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(headers, rows) {
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  /** Parses CSV text (RFC 4180, quoted fields, CRLF/LF). Returns array of objects keyed by lower-cased header. */
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(x => x !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(x => x !== '')) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim().toLowerCase());
    return rows.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      return o;
    });
  }

  const api = { xirr, xnpv, cagr, yearsBetween, toCSV, parseCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Finance = api;
})(typeof self !== 'undefined' ? self : this);
