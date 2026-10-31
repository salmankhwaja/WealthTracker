/* PK Wealth — offline-first portfolio tracker. All data stays in this browser (IndexedDB). */
'use strict';
(() => {
  const F = window.Finance;

  // ---------- constants ----------
  const CLASSES = {
    psx:   { label: 'PSX Stocks',   mode: 'units', unit: 'shares' },
    mf:    { label: 'Mutual Funds', mode: 'units', unit: 'units' },
    bank:  { label: 'Bank Savings', mode: 'value', unit: '' },
    gold:  { label: 'Gold',         mode: 'units', unit: 'tola' },
    fx:    { label: 'Foreign Currency', mode: 'units', unit: 'USD' },
    other: { label: 'Other',        mode: 'value', unit: '' },
  };
  // Internal transaction types. Labels depend on how the holding is tracked.
  const TYPES = {
    units: [
      ['BUY', 'Buy'], ['SELL', 'Sell'], ['INCOME', 'Dividend / profit received'],
      ['REINVEST', 'Bonus / reinvested units'], ['FEE', 'Fee / charges paid'],
    ],
    value: [
      ['BUY', 'Deposit'], ['SELL', 'Withdrawal'], ['INCOME', 'Profit paid out to you'],
    ],
  };
  const TYPE_ALIASES = {
    BUY: 'BUY', DEPOSIT: 'BUY', INVEST: 'BUY', PURCHASE: 'BUY',
    SELL: 'SELL', WITHDRAW: 'SELL', WITHDRAWAL: 'SELL', REDEEM: 'SELL', REDEMPTION: 'SELL',
    INCOME: 'INCOME', DIVIDEND: 'INCOME', PROFIT: 'INCOME', INTEREST: 'INCOME',
    REINVEST: 'REINVEST', BONUS: 'REINVEST',
    FEE: 'FEE', CHARGES: 'FEE', TAX: 'FEE',
  };
  const STALE_DAYS = 30;

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const num = v => {
    if (v == null) return null;
    const t = String(v).replace(/,/g, '').trim();
    return t === '' || !isFinite(+t) ? null : +t;
  };
  // ----- number fields with thousands separators (100,000) -----
  function groupNum(raw) {
    let s = String(raw ?? '').replace(/[^0-9.\-]/g, '');
    const neg = s.startsWith('-'); s = s.replace(/-/g, '');
    const [i, ...rest] = s.split('.');
    const dec = rest.length ? '.' + rest.join('') : '';
    const int = i.replace(/^0+(?=\d)/, '');
    return (neg ? '-' : '') + (int ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : (dec ? '0' : '')) + dec;
  }
  function formatField(el) {
    const before = el.value, caret = el.selectionStart ?? before.length;
    const sig = before.slice(0, caret).replace(/[^0-9.\-]/g, '').length;
    const after = groupNum(before);
    if (after === before) return;
    el.value = after;
    let k = 0, pos = 0;
    while (pos < after.length && k < sig) { if (/[0-9.\-]/.test(after[pos])) k++; pos++; }
    try { if (document.activeElement === el) el.setSelectionRange(pos, pos); } catch { }
  }
  function enhanceNumbers(root) {
    $$('input[type="number"]', root).forEach(el => {
      el.type = 'text'; el.inputMode = 'decimal'; el.classList.add('numeric'); el.autocomplete = 'off';
      if (el.value) el.value = groupNum(el.value);
      el.addEventListener('input', () => formatField(el));
    });
  }
  const setNum = (el, v, dp = 4) => { el.value = v == null || !isFinite(v) ? '' : groupNum(String(+(+v).toFixed(dp))); };
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) enhanceNumbers(n.matches?.('input') ? n.parentNode : n); })
    .observe(document.documentElement, { childList: true, subtree: true });
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const nf0 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 4 });
  const money = v => (v == null ? '—' : (v < 0 ? '−' : '') + 'Rs ' + nf0.format(Math.abs(Math.round(v))));
  const qty = v => (v == null ? '—' : nf2.format(v));
  const pct = v => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(2) + '%');
  const sign = v => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- storage (IndexedDB with localStorage fallback) ----------
  const Store = {
    db: null,
    async open() {
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('pk-wealth', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      } catch { this.db = null; }
    },
    async get(k) {
      if (!this.db) { try { const v = localStorage.getItem('pkw:' + k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } }
      return new Promise((res, rej) => {
        const r = this.db.transaction('kv').objectStore('kv').get(k);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async set(k, v) {
      if (!this.db) { localStorage.setItem('pkw:' + k, JSON.stringify(v)); return; }
      return new Promise((res, rej) => {
        const tx = this.db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
    },
  };

  const emptyState = () => ({ version: 1, holdings: [], txns: [], vals: [], meta: { created: today() } });
  let state = emptyState();

  async function save() {
    state.meta.updated = new Date().toISOString();
    try { await Store.set('state', state); }
    catch (e) { toast('Could not save: ' + e.message); }
  }

  // ---------- calculations ----------
  function holdingStats(h, asOf = today()) {
    const tx = state.txns.filter(t => t.hid === h.id).sort(byDate);
    const vs = state.vals.filter(v => v.hid === h.id).sort(byDate);
    let units = 0, invested = 0, returned = 0;
    const flows = [];
    for (const t of tx) {
      const a = num(t.amount) || 0, u = num(t.units) || 0;
      switch (t.type) {
        case 'BUY': units += u; invested += a; flows.push({ date: t.date, amount: -a }); break;
        case 'SELL': units -= u; returned += a; flows.push({ date: t.date, amount: a }); break;
        case 'INCOME': returned += a; flows.push({ date: t.date, amount: a }); break;
        case 'REINVEST': units += u; break;
        case 'FEE': invested += a; flows.push({ date: t.date, amount: -a }); break;
      }
    }
    if (Math.abs(units) < 1e-9) units = 0;

    let value = 0, valDate = null, price = null, priceSource = null;
    if (h.mode === 'units') {
      const lv = vs.filter(v => num(v.price) != null).pop();
      const lt = [...tx].reverse().find(t => (t.type === 'BUY' || t.type === 'SELL') && num(t.units) > 0 && num(t.amount) > 0);
      if (lv && (!lt || lv.date >= lt.date)) { price = +lv.price; valDate = lv.date; priceSource = 'update'; }
      else if (lt) { price = t2price(lt); valDate = lt.date; priceSource = 'trade'; }
      value = price != null ? units * price : 0;
    } else {
      const lv = vs.filter(v => num(v.value) != null).pop();
      if (lv) {
        value = +lv.value; valDate = lv.date; priceSource = 'update';
        for (const t of tx) if (t.date > lv.date) {
          if (t.type === 'BUY') value += num(t.amount) || 0;
          if (t.type === 'SELL') value -= num(t.amount) || 0;
        }
      } else {
        for (const t of tx) {
          if (t.type === 'BUY') value += num(t.amount) || 0;
          if (t.type === 'SELL') value -= num(t.amount) || 0;
        }
        valDate = tx.length ? tx[tx.length - 1].date : null; priceSource = 'trade';
      }
      if (value < 0) value = 0;
    }
    return finish({ h, tx, vs, units, invested, returned, flows, value, valDate, price, priceSource }, asOf);
  }
  function t2price(t) { return (num(t.amount) || 0) / (num(t.units) || 1); }

  function finish(s, asOf) {
    const flows = s.flows.slice();
    if (s.value > 0) flows.push({ date: asOf, amount: s.value });
    s.gain = s.value + s.returned - s.invested;
    s.absReturn = s.invested > 0 ? s.gain / s.invested : null;
    const first = s.flows.length ? s.flows.map(f => f.date).sort()[0] : null;
    s.firstDate = first;
    s.years = first ? F.yearsBetween(first, asOf) : 0;
    s.xirr = flows.length >= 2 ? F.xirr(flows) : null;
    s.cagr = s.invested > 0 && s.years > 0 ? F.cagr(s.invested, s.value + s.returned, s.years) : null;
    s.short = s.years > 0 && s.years < 1;
    s.stale = s.value > 0 && s.valDate && daysBetween(s.valDate, asOf) > STALE_DAYS;
    return s;
  }

  function aggregate(list, asOf = today()) {
    const s = { flows: [], invested: 0, returned: 0, value: 0 };
    for (const x of list) {
      s.flows.push(...x.flows); s.invested += x.invested; s.returned += x.returned; s.value += x.value;
    }
    return finish(s, asOf);
  }

  function allStats() {
    const per = state.holdings.map(h => holdingStats(h));
    const byClass = {};
    for (const k of Object.keys(CLASSES)) {
      const list = per.filter(p => p.h.cls === k);
      if (list.length) byClass[k] = { list, agg: aggregate(list) };
    }
    return { per, byClass, total: aggregate(per) };
  }

  // ---------- rendering ----------
  function metricLine(s) {
    const tag = s.short ? ' <span class="badge" title="Less than 1 year: annualised figures swing a lot">&lt;1y</span>' : '';
    return `XIRR <b class="${sign(s.xirr)}">${pct(s.xirr)}</b>${tag}`;
  }

  function renderOverview() {
    const el = $('#view-overview');
    if (!state.holdings.length) {
      el.innerHTML = `<div class="card empty">
        <h2>Track everything in one place</h2>
        <p>PSX shares, mutual funds, bank savings and gold — with XIRR and CAGR. Your data never leaves this device.</p>
        <button class="primary" id="btn-first">Add your first holding</button>
        <p><button class="link" id="btn-sample">or load sample data to explore</button></p>
      </div>`;
      $('#btn-first').onclick = () => openHolding();
      $('#btn-sample').onclick = loadSample;
      return;
    }
    const { byClass, total, per } = allStats();
    const stale = per.filter(p => p.stale).length;
    const classKeys = Object.keys(byClass);
    el.innerHTML = `
      <div class="card hero">
        <div class="label">Net worth</div>
        <div class="big">${money(total.value)}</div>
        <div class="kpis">
          <div class="kpi"><div class="k">Invested (net of fees)</div><div class="v">${money(total.invested)}</div></div>
          <div class="kpi"><div class="k">Total gain</div><div class="v ${sign(total.gain)}">${money(total.gain)}</div></div>
          <div class="kpi"><div class="k">XIRR</div><div class="v ${sign(total.xirr)}">${pct(total.xirr)}</div></div>
          <div class="kpi"><div class="k">CAGR (simple)</div><div class="v ${sign(total.cagr)}">${pct(total.cagr)}</div></div>
        </div>
        <div class="alloc" id="alloc">${classKeys.map(k => `<span class="bg-${k}" data-w="${total.value ? byClass[k].agg.value / total.value : 0}"></span>`).join('')}</div>
        <div class="legend">${classKeys.map(k => `<span><i class="dot bg-${k}"></i>${CLASSES[k].label} ${total.value ? Math.round(byClass[k].agg.value / total.value * 100) : 0}%</span>`).join('')}</div>
      </div>
      ${marketCardHTML()}
      ${stale ? `<div class="note">${stale} holding${stale > 1 ? 's have' : ' has'} a price or balance older than ${STALE_DAYS} days, so returns may be off. <button class="link" data-goto="update">Update now</button></div>` : ''}
      <h3>By asset class</h3>
      ${classKeys.map(k => {
        const a = byClass[k].agg;
        return `<div class="card">
          <div class="class-head"><span class="t"><i class="dot bg-${k}"></i>${CLASSES[k].label}</span><span>${money(a.value)}</span></div>
          <div class="row flat" data-class="${k}">
            <div><div class="sub">Gain ${money(a.gain)} · ${pct(a.absReturn)} absolute</div></div>
            <div class="right"><div>${metricLine(a)}</div><div class="sub">CAGR ${pct(a.cagr)}</div></div>
          </div>
        </div>`;
      }).join('')}
      <p class="info">XIRR accounts for when each rupee went in or came out, so it is the fair number for SIPs, top-ups and withdrawals. Simple CAGR treats all money as invested on day one, so it understates returns when you added money over time.</p>
    `;
    $$('#alloc span', el).forEach(s => { s.style.width = (parseFloat(s.dataset.w) * 100) + '%'; });
    $$('[data-class]', el).forEach(r => r.onclick = () => { showView('holdings'); });
    wireMarketCard(el);
  }

  function dayChg(h) {
    const lp = h.feed?.type === 'psx' ? livePrice(h) : null;
    return lp && lp.changePct != null ? ` <span class="small ${sign(lp.changePct)}">${lp.changePct >= 0 ? '▲' : '▼'}${Math.abs(lp.changePct).toFixed(2)}%</span>` : '';
  }

  function renderHoldings() {
    const el = $('#view-holdings');
    if (!state.holdings.length) {
      el.innerHTML = `<div class="card empty"><p>No holdings yet.</p><button class="primary" id="h-add">New holding</button></div>`;
      $('#h-add').onclick = () => openHolding();
      return;
    }
    const { byClass } = allStats();
    el.innerHTML = `<div class="btn-grid"><button class="primary" id="h-add">New holding</button><button class="ghost" id="h-txn">Add transaction</button></div>` +
      Object.keys(byClass).map(k => `
        <h3><i class="dot bg-${k}"></i>${CLASSES[k].label}</h3>
        <div class="card">${byClass[k].list
          .sort((a, b) => b.value - a.value)
          .map(s => `<div class="row" data-hid="${s.h.id}">
            <div><div class="name">${esc(s.h.name)}${s.stale ? '<span class="badge">stale</span>' : ''}</div>
              <div class="sub">${s.h.mode === 'units' ? `${qty(s.units)} ${esc(s.h.unit || '')} @ ${s.price != null ? qty(s.price) : '—'}` : `as of ${fmtDate(s.valDate)}`}</div></div>
            <div class="right"><div>${money(s.value)}${dayChg(s.h)}</div><div class="sub">${metricLine(s)}</div></div>
          </div>`).join('')}</div>`).join('');
    $('#h-add').onclick = () => openHolding();
    $('#h-txn').onclick = () => openTxn();
    $$('[data-hid]', el).forEach(r => r.onclick = () => openDetail(r.dataset.hid));
  }

  function renderUpdate() {
    const el = $('#view-update');
    const active = state.holdings.map(h => holdingStats(h)).filter(s => s.units > 0 || s.h.mode === 'value' && s.value > 0);
    if (!active.length) {
      el.innerHTML = `<div class="card empty"><p>Nothing to update yet. Add a holding and a purchase first.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="upd">
      <div class="card">
        <h2>Update prices & balances</h2>
        <p class="info">Enter today's NAV, share price, gold rate per unit, or bank balance. Leave a field unchanged to skip it.</p>
        <div class="date-row"><span class="muted small">As of</span><input type="date" id="upd-date" value="${today()}"></div>
        ${linked().length ? `<button class="ghost block gap-top" id="upd-fill">Fill ${linked().length} linked holding${linked().length > 1 ? 's' : ''} from latest prices</button>` : '<p class="info small">Tip: link a holding to a MUFAP fund, gold or a currency (Edit holding → Auto price) to fill prices automatically.</p>'}
      </div>
      ${Object.keys(CLASSES).map(k => {
        const list = active.filter(s => s.h.cls === k);
        if (!list.length) return '';
        return `<h3><i class="dot bg-${k}"></i>${CLASSES[k].label}</h3><div class="card">${list.map(s => {
          const cur = s.h.mode === 'units' ? s.price : s.value;
          return `<div class="row"><div class="name">${esc(s.h.name)}
              <div class="sub">${s.h.mode === 'units' ? `${qty(s.units)} ${esc(s.h.unit || '')} · price` : 'balance'} last set ${fmtDate(s.valDate)}${s.h.feed ? ' · <span class="auto-tag">auto</span>' : ''}</div></div>
            <input type="number" step="any" min="0" inputmode="decimal" data-upd="${s.h.id}" data-orig="${cur ?? ''}" value="${cur != null ? +(+cur).toFixed(4) : ''}" aria-label="${esc(s.h.name)}">
          </div>`;
        }).join('')}</div>`;
      }).join('')}
      <button class="primary block" id="upd-save">Save updates</button>
      <p class="info small center"><button class="link" id="upd-same">Re-confirm all current values for this date</button></p>
    </div>`;
    $$('[data-upd]', el).forEach(i => i.addEventListener('input', () => { i.dataset.dirty = '1'; }));
    $('#upd-save').onclick = async () => {
      const date = $('#upd-date').value || today();
      let n = 0;
      for (const inp of $$('[data-upd]', el)) {
        const v = num(inp.value);
        if (v == null || !inp.dataset.dirty) continue;
        const h = state.holdings.find(x => x.id === inp.dataset.upd);
        state.vals = state.vals.filter(x => !(x.hid === h.id && x.date === date));
        state.vals.push(h.mode === 'units' ? { id: uid(), hid: h.id, date, price: v } : { id: uid(), hid: h.id, date, value: v });
        n++;
      }
      await save(); renderAll();
      toast(n ? `Saved ${n} update${n > 1 ? 's' : ''}` : 'Nothing changed — edit a field first');
    };
    const stale = $$('[data-upd]', el);
    if ($('#upd-fill')) $('#upd-fill').onclick = async () => {
      await loadFeed(true);
      let n = 0;
      for (const inp of $$('[data-upd]', el)) {
        const h = state.holdings.find(x => x.id === inp.dataset.upd);
        const lp = h && livePrice(h);
        if (lp && lp.price > 0) { setNum(inp, lp.price); inp.dataset.dirty = '1'; n++; }
      }
      toast(n ? `Filled ${n} price${n > 1 ? 's' : ''} — review, then Save` : 'No live prices available right now');
    };
    $('#upd-same').onclick = () => { stale.forEach(i => { if (i.value !== '') i.dataset.dirty = '1'; }); $('#upd-save').click(); };
  }

  async function renderData() {
    const el = $('#view-data');
    let persisted = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { }
    el.innerHTML = `
      <div class="card">
        <h2>Your data</h2>
        <p class="info">${state.holdings.length} holdings · ${state.txns.length} transactions · ${state.vals.length} price/balance updates.<br>
        Stored only in this browser on this device${persisted === true ? ' (protected from automatic clean-up)' : persisted === false ? ' — <b>not yet protected</b> from browser clean-up' : ''}.
        Last change: ${state.meta.updated ? new Date(state.meta.updated).toLocaleString() : '—'}.</p>
        ${persisted === false ? '<button class="chip" id="d-persist">Protect storage</button>' : ''}
      </div>
      <h3>Market prices & sources</h3>
      <div id="mkt-settings">${marketSettingsHTML()}</div>
      <h3>Backup & move between devices</h3>
      <div class="card">
        <p class="info">One encrypted file holds everything. Restore it on another phone or PC to carry on there. Put it in a Syncthing folder or cloud drive — only ciphertext leaves the device.</p>
        <div class="btn-grid">
          <button class="primary" id="d-backup">Save backup</button>
          <button class="ghost" id="d-restore">Restore backup</button>
        </div>
        ${navigator.canShare ? '<p><button class="link" id="d-share">Share backup to an app…</button></p>' : ''}
      </div>
      <h3>CSV (Excel / Google Sheets / LibreOffice)</h3>
      <div class="card">
        <div class="btn-grid">
          <button class="ghost" id="d-csv-tx">Transactions.csv</button>
          <button class="ghost" id="d-csv-val">Prices.csv</button>
          <button class="ghost" id="d-csv-h">Holdings.csv</button>
          <button class="ghost" id="d-csv-sum">Summary.csv</button>
        </div>
        <p><button class="link" id="d-import">Import CSV…</button></p>
        <p class="info small">Import accepts the same columns as the exports. Transactions: <code>date, holding, class, type, amount, units, note</code>. Prices: <code>date, holding, price, value</code>. Unknown holdings are created automatically; exact duplicates are skipped.</p>
      </div>
      <h3>Danger zone</h3>
      <div class="card"><button class="danger" id="d-wipe">Erase all data on this device</button></div>
      <p class="info small">PK Wealth ${APP_VERSION} · open source · no accounts, no servers, no trackers.</p>
    `;
    wireMarketSettings($('#mkt-settings'));
    $('#d-backup').onclick = () => backup(false);
    $('#d-restore').onclick = () => pickFile('json');
    if ($('#d-share')) $('#d-share').onclick = () => backup(true);
    $('#d-csv-tx').onclick = () => download('pkwealth-transactions.csv', exportTxCSV(), 'text/csv');
    $('#d-csv-val').onclick = () => download('pkwealth-prices.csv', exportValCSV(), 'text/csv');
    $('#d-csv-h').onclick = () => download('pkwealth-holdings.csv', exportHoldingsCSV(), 'text/csv');
    $('#d-csv-sum').onclick = () => download('pkwealth-summary-' + today() + '.csv', exportSummaryCSV(), 'text/csv');
    $('#d-import').onclick = () => pickFile('csv');
    $('#d-wipe').onclick = async () => {
      if (!confirm('Erase every holding, transaction and price on this device? Save a backup first if unsure.')) return;
      if (prompt('Type ERASE to confirm') !== 'ERASE') return;
      state = emptyState(); await save(); renderAll(); toast('All data erased');
    };
    if ($('#d-persist')) $('#d-persist').onclick = async () => {
      const ok = await navigator.storage.persist();
      toast(ok ? 'Storage protected' : 'Browser declined — install the app to the home screen and try again');
      renderData();
    };
  }

  function renderAll() {
    normalizeZakat(); normalizeMarket();
    renderOverview(); renderHoldings(); renderUpdate(); renderData();
    if (!$('#view-zakat').contains(document.activeElement)) renderZakat();
    $('#fab').hidden = !state.holdings.length;
  }

  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    window.scrollTo(0, 0);
  }

  // ---------- Zakat ----------
  const Z = window.Zakat;
  const DEFAULT_CHARITIES = [
    { id: 'skmch', name: 'Shaukat Khanum Memorial Cancer Hospital', url: 'https://shaukatkhanum.org.pk/donors/zakat/', note: 'Zakat for free cancer treatment — card, bank transfer and other options on this page.' },
    { id: 'zindagi', name: 'Zindagi Trust', url: 'https://www.zindagitrust.org/donate', note: 'Reforms government schools for underprivileged children.' },
    { id: 'tcf', name: 'The Citizens Foundation (TCF)', url: 'https://www.tcf.org.pk/zakat-calculator/', note: 'Schools for low-income communities — “Give your Zakat” on this page.' },
  ];
  const VERIFY_LINKS = [
    { name: 'FBR — Federal Board of Revenue', url: 'https://www.fbr.gov.pk', note: 'A donation earns an income-tax credit only if the organisation is approved by FBR under section 2(36). Ask the charity for its current approval certificate and a receipt showing its NTN.' },
    { name: 'Pakistan Centre for Philanthropy', url: 'https://pcp.org.pk', note: 'Independent certification of non-profits’ governance and finances; FBR approval commonly relies on it.' },
  ];
  const ZK_MANUAL = {
    assets: [
      ['cash', 'Cash in hand & bank balances not tracked here'],
      ['saved', 'Cash set aside for a purpose (e.g. Hajj, wedding)'],
      ['loansGiven', 'Loans you gave and expect back'],
      ['certificates', 'Prize bonds, savings certificates, accessible pension'],
      ['trade', 'Business stock / goods held for sale'],
      ['otherAssets', 'Any other zakatable asset'],
    ],
    liabilities: [
      ['borrowed', 'Borrowed money & goods bought on credit (due now)'],
      ['wages', 'Wages due to employees'],
      ['bills', 'Taxes, rent and utility bills due now'],
    ],
  };
  const emptyZakat = () => ({
    settings: { date: '', calendar: 'lunar', basis: 'auto', rateUnit: 'tola', goldRate: '', silverRate: '', include: {}, manual: {}, goldQty: '', silverQty: '', deducted: '' },
    history: [],
    charities: DEFAULT_CHARITIES.map(c => ({ ...c })),
  });
  function normalizeZakat() {
    const e = emptyZakat();
    state.zakat = { ...e, ...(state.zakat || {}) };
    state.zakat.settings = { ...e.settings, ...(state.zakat.settings || {}) };
    if (!Array.isArray(state.zakat.history)) state.zakat.history = [];
    if (!Array.isArray(state.zakat.charities)) state.zakat.charities = e.charities;
  }

  // Gold rate per settings unit derived from a gold holding priced per tola or gram.
  function goldRateFromPortfolio(unit) {
    for (const h of state.holdings.filter(x => x.cls === 'gold' && x.mode === 'units')) {
      const s = holdingStats(h);
      const u = (h.unit || '').toLowerCase();
      if (s.price == null) continue;
      const perG = /tola/.test(u) ? s.price / Z.GRAMS_PER_TOLA : /^g(ram)?s?$/.test(u) ? s.price : null;
      if (perG) return unit === 'tola' ? perG * Z.GRAMS_PER_TOLA : perG;
    }
    return null;
  }

  function zakatInputs() {
    const st = state.zakat.settings;
    const goldRate = num(st.goldRate) ?? goldRateFromPortfolio(st.rateUnit);
    const silverRate = num(st.silverRate);
    const assets = [];
    for (const s of state.holdings.map(h => holdingStats(h))) {
      if (!(s.value > 0)) continue;
      const inc = st.include[s.h.id] || {};
      if (inc.on === false) continue;
      assets.push({ label: s.h.name, value: s.value, pct: num(inc.pct) ?? 100, kind: s.h.cls === 'gold' ? 'gold' : 'other' });
    }
    for (const [k, label] of ZK_MANUAL.assets) assets.push({ label, value: num(st.manual[k]) || 0 });
    const gq = Z.toGrams(st.goldQty, st.rateUnit), sq = Z.toGrams(st.silverQty, st.rateUnit);
    if (gq) assets.push({ label: 'Gold not in portfolio', value: gq * Z.perGram(goldRate, st.rateUnit), kind: 'gold' });
    if (sq) assets.push({ label: 'Silver', value: sq * Z.perGram(silverRate, st.rateUnit), kind: 'silver' });
    const liabilities = ZK_MANUAL.liabilities.map(([k, label]) => ({ label, value: num(st.manual[k]) || 0 }));
    return { goldRate, silverRate, rateUnit: st.rateUnit, basis: st.basis, calendar: st.calendar, assets, liabilities, deducted: num(st.deducted) || 0 };
  }

  let zkSaveTimer = null;
  function zkPersist() { clearTimeout(zkSaveTimer); zkSaveTimer = setTimeout(save, 400); }

  function renderZakat() {
    const el = $('#view-zakat');
    const st = state.zakat.settings;
    const unit = st.rateUnit;
    const derivedGold = goldRateFromPortfolio(unit);
    const held = state.holdings.map(h => holdingStats(h)).filter(s => s.value > 0);
    const field = (key, label, val, extra = '') => `<label class="zk-field">${label}<input type="number" step="any" min="0" inputmode="decimal" data-zk="${key}" value="${esc(val ?? '')}" ${extra}></label>`;
    el.innerHTML = `
      <div class="card">
        <h2>Zakat calculator</h2>
        <p class="info">2.5% of net zakatable wealth held for a full lunar year, once it is at or above nisab. Values from your portfolio use the latest prices — update them on your Zakat date first.</p>
        <div class="zk-grid">
          <label class="zk-field">Zakat date<input type="date" data-zk="date" value="${esc(st.date)}"></label>
          <label class="zk-field">Year counted as
            <select data-zk="calendar"><option value="lunar">Lunar (2.5%)</option><option value="solar">Gregorian (2.5775%)</option></select></label>
        </div>
      </div>

      <h3>Gold & silver rates</h3>
      <div class="card">
        <div class="zk-grid">
          <label class="zk-field">Rates per
            <select data-zk="rateUnit"><option value="tola">Tola (11.664 g)</option><option value="gram">Gram</option></select></label>
          <label class="zk-field">Nisab basis
            <select data-zk="basis"><option value="auto">Auto (gold-only → gold, else silver)</option><option value="silver">Silver — 52.5 tola</option><option value="gold">Gold — 7.5 tola</option></select></label>
          ${field('goldRate', `Gold price per ${unit} (PKR)`, st.goldRate, derivedGold ? `placeholder="${Math.round(derivedGold)} (from your gold holding)"` : 'placeholder="today’s rate"')}
          ${field('silverRate', `Silver price per ${unit} (PKR)`, st.silverRate, 'placeholder="today’s rate"')}
        </div>
        <button class="ghost block" id="zk-mkt">Use market rates (${state.market?.gold?.source === 'manual' ? 'your rate' : 'spot'})</button>
        <p class="info small">Fills 24K gold and silver from the Market settings on the Data tab. Check against your jeweller or Sarafa rate.</p>
      </div>

      <h3>From your portfolio</h3>
      <div class="card">
        ${held.length ? held.map(s => {
          const inc = st.include[s.h.id] || {};
          return `<div class="row zk-hold">
            <label class="zk-check"><input type="checkbox" data-inc-on="${s.h.id}" ${inc.on === false ? '' : 'checked'}>
              <span><span class="name">${esc(s.h.name)}</span><br><span class="sub"><i class="dot bg-${s.h.cls}"></i>${money(s.value)}</span></span></label>
            <label class="zk-pct"><input type="number" min="0" max="100" step="any" inputmode="decimal" data-inc-pct="${s.h.id}" value="${esc(inc.pct ?? 100)}" aria-label="Percent counted for ${esc(s.h.name)}">%</label>
          </div>`;
        }).join('') : '<p class="muted">No holdings with a value yet.</p>'}
        <p class="info small">Untick anything not zakatable for you. For long-term shares, some scholars count only the company's zakatable assets per share — lower the % if you follow that view. Personal-use items (home, car, furniture) are not zakatable.</p>
      </div>

      <h3>Other assets</h3>
      <div class="card">
        ${ZK_MANUAL.assets.map(([k, l]) => field('manual.' + k, l + ' (PKR)', st.manual[k])).join('')}
        <div class="zk-grid">
          ${field('goldQty', `Gold not in portfolio, e.g. jewellery (${unit})`, st.goldQty)}
          ${field('silverQty', `Silver (${unit})`, st.silverQty)}
        </div>
      </div>

      <h3>Deduct</h3>
      <div class="card">
        ${ZK_MANUAL.liabilities.map(([k, l]) => field('manual.' + k, l + ' (PKR)', st.manual[k])).join('')}
        ${field('deducted', 'Zakat already deducted at source by bank / fund (PKR)', st.deducted)}
        <p class="info small">Banks and funds deduct Zakat on 1 Ramadan unless you've filed a CZ-50 declaration. Count those balances above and enter the deduction here so you don't pay twice.</p>
      </div>

      <div class="card zk-result" id="zk-result"></div>

      <h3>Zakat history</h3>
      <div id="zk-history"></div>

      <h3>Where to give</h3>
      <div class="card list-mini" id="zk-charities"></div>
      <details class="card zk-add">
        <summary>Add your own charity</summary>
        <label class="zk-field">Name<input type="text" id="zk-c-name" maxlength="80"></label>
        <label class="zk-field">Donation page (https://…)<input type="url" id="zk-c-url" maxlength="300" inputmode="url"></label>
        <button class="primary" id="zk-c-add">Add</button>
      </details>
      <h3>Check before you claim a tax credit</h3>
      <div class="card list-mini">${VERIFY_LINKS.map(v => `<div class="li"><div><b>${esc(v.name)}</b><br><span class="muted">${esc(v.note)}</span></div>
        <a class="chip-link" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`).join('')}</div>
      <p class="info small">This is a calculator, not a religious ruling. Rules here follow common Hanafi practice in Pakistan; consult a scholar for your situation.</p>
    `;
    $('[data-zk="calendar"]', el).value = st.calendar;
    $('[data-zk="rateUnit"]', el).value = st.rateUnit;
    $('[data-zk="basis"]', el).value = st.basis;

    $$('[data-zk]', el).forEach(inp => inp.addEventListener('input', () => {
      const key = inp.dataset.zk;
      if (key.startsWith('manual.')) st.manual[key.slice(7)] = inp.value; else st[key] = inp.value;
      zkPersist();
      if (key === 'rateUnit') { // convert any entered rates and quantities to the new unit
        const f = inp.value === 'tola' ? Z.GRAMS_PER_TOLA : 1 / Z.GRAMS_PER_TOLA;
        for (const k of ['goldRate', 'silverRate']) if (num(st[k]) != null) st[k] = String(+(num(st[k]) * f).toFixed(2));
        for (const k of ['goldQty', 'silverQty']) if (num(st[k]) != null) st[k] = String(+(num(st[k]) / f).toFixed(4));
        renderZakat(); return;
      }
      updateZakatResult();
    }));
    $$('[data-inc-on]', el).forEach(c => c.addEventListener('change', () => {
      (st.include[c.dataset.incOn] ||= {}).on = c.checked; zkPersist(); updateZakatResult();
    }));
    $$('[data-inc-pct]', el).forEach(c => c.addEventListener('input', () => {
      (st.include[c.dataset.incPct] ||= {}).pct = c.value; zkPersist(); updateZakatResult();
    }));
    $('#zk-mkt').onclick = () => {
      const g = FD.metalPerGram(feedData, 'gold', state.market), sv = FD.metalPerGram(feedData, 'silver', state.market);
      if (!g && !sv) { toast('Market rates not available yet'); return; }
      const per = st.rateUnit === 'tola' ? FD.TOLA_G : 1;
      if (g) st.goldRate = String(Math.round(g.perGram * per * 100) / 100);
      if (sv) st.silverRate = String(Math.round(sv.perGram * per * 100) / 100);
      zkPersist(); renderZakat(); toast('Rates filled');
    };
    $('#zk-c-add').onclick = async () => {
      const name = $('#zk-c-name').value.trim(), url = $('#zk-c-url').value.trim();
      if (!name) { toast('Enter a name'); return; }
      if (!/^https:\/\/[^\s]+$/i.test(url)) { toast('Link must start with https://'); return; }
      state.zakat.charities.push({ id: uid(), name, url, note: '' });
      await save(); renderZakat(); toast('Charity added');
    };
    updateZakatResult(); renderZakatHistory(); renderCharities();
  }

  function updateZakatResult() {
    const r = Z.computeZakat(zakatInputs());
    const st = state.zakat.settings;
    const box = $('#zk-result');
    const nisabTxt = r.missingRate
      ? `<span class="neg">Enter the ${r.basisUsed} rate to work out nisab</span>`
      : `${money(r.nisabValue)} <span class="muted small">(${r.basisUsed}${st.basis === 'auto' ? ', auto' : ''})</span>`;
    box.innerHTML = `
      <div class="zk-line"><span>Zakatable assets</span><b>${money(r.gross)}</b></div>
      <div class="zk-line"><span>Less debts due now</span><b>${money(-r.debts)}</b></div>
      <div class="zk-line"><span>Net zakatable wealth</span><b>${money(r.net)}</b></div>
      <div class="zk-line"><span>Nisab</span><b>${nisabTxt}</b></div>
      <div class="zk-line"><span>Zakat due (${(r.rate * 100).toFixed(r.rate === 0.025 ? 1 : 4)}%)</span><b>${money(r.due)}</b></div>
      ${r.deducted ? `<div class="zk-line"><span>Less deducted at source</span><b>${money(-r.deducted)}</b></div>` : ''}
      <div class="zk-total"><span>Zakat payable</span><span>${money(r.payable)}</span></div>
      ${!r.missingRate && !r.aboveNisab && r.net > 0 ? '<p class="info small">Below nisab — no Zakat is due on this wealth.</p>' : ''}
      <div class="btn-grid"><button class="primary" id="zk-save">Save to history</button><button class="ghost" id="zk-csv">Export CSV</button></div>
    `;
    $('#zk-save').onclick = async () => {
      if (r.missingRate) { toast('Enter the gold/silver rate first'); return; }
      const date = st.date || today();
      const entry = { id: uid(), date, calendar: st.calendar, basis: r.basisUsed, nisab: r.nisabValue, gross: r.gross, debts: r.debts, net: r.net, due: r.due, deducted: r.deducted, payable: r.payable,
        lines: r.assets.map(a => ({ label: a.label, value: a.value, pct: a.pct })), payments: [] };
      const existing = state.zakat.history.find(h => h.date === date);
      if (existing) {
        if (!confirm(`Replace the calculation saved for ${fmtDate(date)}? Payments recorded against it are kept.`)) return;
        entry.payments = existing.payments; entry.id = existing.id;
        state.zakat.history = state.zakat.history.filter(h => h !== existing);
      }
      state.zakat.history.push(entry);
      await save(); renderZakatHistory(); toast('Saved for ' + fmtDate(date));
    };
    $('#zk-csv').onclick = () => download('pkwealth-zakat-' + (st.date || today()) + '.csv', zakatCSV(r), 'text/csv');
  }

  function zakatCSV(r) {
    const rows = [
      ...r.assets.map(a => ({ section: 'Asset', item: a.label, value: a.value.toFixed(2), pct_counted: a.pct, counted: a.counted.toFixed(2) })),
      ...r.liabilities.map(l => ({ section: 'Liability', item: l.label, value: l.value.toFixed(2), pct_counted: 100, counted: (-l.value).toFixed(2) })),
      { section: 'Total', item: 'Net zakatable wealth', counted: r.net.toFixed(2) },
      { section: 'Total', item: `Nisab (${r.basisUsed})`, counted: r.nisabValue == null ? '' : r.nisabValue.toFixed(2) },
      { section: 'Total', item: `Zakat due (${(r.rate * 100).toFixed(4)}%)`, counted: r.due.toFixed(2) },
      { section: 'Total', item: 'Deducted at source', counted: (-r.deducted).toFixed(2) },
      { section: 'Total', item: 'Zakat payable', counted: r.payable.toFixed(2) },
    ];
    const hist = [];
    for (const h of state.zakat.history) for (const p of h.payments) hist.push({ section: 'Payment', item: `${p.charity}${p.note ? ' — ' + p.note : ''}`, value: p.amount, pct_counted: '', counted: `zakat year ${h.date}; paid ${p.date}` });
    return F.toCSV(['section', 'item', 'value', 'pct_counted', 'counted'], rows.concat(hist));
  }

  function renderZakatHistory() {
    const box = $('#zk-history');
    const list = state.zakat.history.slice().sort(byDate).reverse();
    if (!list.length) { box.innerHTML = '<div class="card"><p class="muted">Save a calculation to track what you have paid against it.</p></div>'; return; }
    box.innerHTML = list.map(h => {
      const paid = h.payments.reduce((t, p) => t + (+p.amount || 0), 0);
      const left = h.payable - paid;
      return `<div class="card">
        <div class="class-head"><span class="t">${fmtDate(h.date)}</span><span>${money(h.payable)}</span></div>
        <div class="sub muted small">Net ${money(h.net)} · nisab ${money(h.nisab)} (${h.basis})${h.deducted ? ' · deducted at source ' + money(h.deducted) : ''}</div>
        <div class="zk-progress"><span data-w="${h.payable > 0 ? Math.min(1, paid / h.payable) : 1}"></span></div>
        <div class="zk-line"><span>Paid ${money(paid)}</span><b class="${left > 0.5 ? 'neg' : 'pos'}">${left > 0.5 ? money(left) + ' left' : 'Fully paid'}</b></div>
        <div class="list-mini">${h.payments.map(p => `<div class="li"><div>${fmtDate(p.date)} · <b>${esc(p.charity)}</b>${p.note ? ' · <span class="muted">' + esc(p.note) + '</span>' : ''}</div>
          <div>${money(p.amount)} <button class="del" data-del-pay="${h.id}|${p.id}" aria-label="Delete payment">×</button></div></div>`).join('')}</div>
        <div class="zk-actions"><button class="chip" data-pay="${h.id}">Record payment</button><button class="link danger-link" data-del-zk="${h.id}">Delete</button></div>
      </div>`;
    }).join('');
    $$('.zk-progress span', box).forEach(s => { s.style.width = (parseFloat(s.dataset.w) * 100) + '%'; });
    $$('[data-pay]', box).forEach(b => b.onclick = () => openPayment(b.dataset.pay));
    $$('[data-del-pay]', box).forEach(b => b.onclick = async () => {
      const [hid, pid] = b.dataset.delPay.split('|');
      if (!confirm('Delete this payment?')) return;
      const h = state.zakat.history.find(x => x.id === hid); h.payments = h.payments.filter(p => p.id !== pid);
      await save(); renderZakatHistory();
    });
    $$('[data-del-zk]', box).forEach(b => b.onclick = async () => {
      if (!confirm('Delete this saved calculation and its payments?')) return;
      state.zakat.history = state.zakat.history.filter(h => h.id !== b.dataset.delZk);
      await save(); renderZakatHistory();
    });
  }

  function renderCharities() {
    const box = $('#zk-charities');
    const list = state.zakat.charities;
    box.innerHTML = list.length ? list.map(c => `<div class="li"><div><b>${esc(c.name)}</b>${c.note ? '<br><span class="muted">' + esc(c.note) + '</span>' : ''}</div>
      <div class="zk-c-actions"><a class="chip-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Give ↗</a><button class="del" data-del-ch="${c.id}" aria-label="Remove ${esc(c.name)}">×</button></div></div>`).join('')
      : '<p class="muted">No charities saved. <button class="link" id="zk-c-reset">Restore the defaults</button></p>';
    $$('[data-del-ch]', box).forEach(b => b.onclick = async () => {
      state.zakat.charities = state.zakat.charities.filter(c => c.id !== b.dataset.delCh); await save(); renderCharities();
    });
    if ($('#zk-c-reset')) $('#zk-c-reset').onclick = async () => { state.zakat.charities = DEFAULT_CHARITIES.map(c => ({ ...c })); await save(); renderCharities(); };
  }

  function openPayment(hid) {
    const h = state.zakat.history.find(x => x.id === hid);
    const dlg = $('#dlg-pay'), f = $('#form-pay');
    f.reset();
    const paid = h.payments.reduce((t, p) => t + (+p.amount || 0), 0);
    f.elements.amount.value = Math.max(0, Math.round(h.payable - paid)) || '';
    f.elements.date.value = today();
    $('#pay-charity').innerHTML = state.zakat.charities.map(c => `<option>${esc(c.name)}</option>`).join('') + '<option value="__other">Other…</option>';
    const sync = () => { $('#pay-other-wrap').hidden = f.elements.charity.value !== '__other'; };
    f.elements.charity.onchange = sync; sync();
    f.onsubmit = async e => {
      e.preventDefault();
      const amount = num(f.elements.amount.value);
      if (!(amount > 0)) { toast('Enter an amount'); return; }
      const charity = f.elements.charity.value === '__other' ? (f.elements.other.value.trim() || 'Other') : f.elements.charity.value;
      h.payments.push({ id: uid(), date: f.elements.date.value || today(), amount, charity, note: f.elements.note.value.trim() });
      await save(); dlg.close(); renderZakatHistory(); toast('Payment recorded');
    };
    closeOn(dlg); dlg.showModal();
  }

  // ---------- Market prices (data/prices.json, refreshed by a GitHub Action) ----------
  const FD = window.Feed;
  const FX_CODES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'CNY'];
  let feedData = null;
  const emptyMarket = () => ({ broker: 'psx-minimum', gold: { source: 'spot', premiumPct: '', manualTola: '', manualDate: '' }, silver: { source: 'spot', premiumPct: '', manualTola: '', manualDate: '' }, navField: 'nav', autoApply: true });
  function normalizeMarket() {
    const e = emptyMarket();
    state.market = { ...e, ...(state.market || {}) };
    state.market.gold = { ...e.gold, ...(state.market.gold || {}) };
    state.market.silver = { ...e.silver, ...(state.market.silver || {}) };
  }
  async function loadFeed(force) {
    try {
      const r = await fetch('data/prices.json', { cache: force ? 'no-store' : 'no-cache' });
      if (r.ok) { feedData = await r.json(); try { await Store.set('feed', feedData); } catch { } }
    } catch { }
    if (!feedData) { try { feedData = (await Store.get('feed')) || null; } catch { } }
    if (feedData) await loadPsx(force);
    return feedData;
  }
  // PSX prices are published only encrypted (PSX restricts redistribution); decrypt with the device-held passphrase.
  async function loadPsx(force) {
    let pass = null, doc = null;
    try { pass = await Store.get('psxkey'); } catch { }
    if (!pass) return false;
    try {
      const r = await fetch('data/psx.enc.json', { cache: force ? 'no-store' : 'no-cache' });
      if (r.ok) { doc = await r.json(); try { await Store.set('psxenc', doc); } catch { } }
    } catch { }
    if (!doc) { try { doc = await Store.get('psxenc'); } catch { } }
    if (!doc) return false;
    try { feedData.psx = await FD.decryptDoc(doc, pass); feedData.psx.stale = !!feedData.psx_private?.stale; return true; }
    catch { feedData.psx = null; feedData.psxError = 'wrong passphrase'; return false; }
  }
  const linked = () => state.holdings.filter(h => h.feed && h.mode === 'units');
  const livePrice = h => (h.feed ? FD.priceFor(feedData, h.feed, h.unit, state.market) : null);

  /** Adds a dated price for every linked holding from the feed. Returns number of holdings updated. */
  function applyFeed() {
    if (!feedData) return 0;
    let n = 0;
    const t = today();
    for (const h of linked()) {
      const lp = livePrice(h);
      if (!lp || !(lp.price > 0) || !lp.date) continue;
      const date = lp.date > t ? t : lp.date;
      const same = state.vals.find(v => v.hid === h.id && v.date === date);
      if (same && !same.auto) continue;                       // never overwrite a price the user typed
      if (same && Math.abs(+same.price - lp.price) < 1e-9) continue;
      const newer = state.vals.some(v => v.hid === h.id && v.date > date && !v.auto);
      if (newer) continue;
      state.vals = state.vals.filter(v => v !== same);
      state.vals.push({ id: uid(), hid: h.id, date, price: +lp.price.toFixed(6), auto: true, src: lp.source });
      n++;
    }
    return n;
  }

  function ago(iso) {
    if (!iso) return '—';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 60) return m + ' min ago';
    if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }

  function marketCardHTML() {
    if (!feedData) return `<div class="card mkt"><div class="class-head"><span class="t">Market today</span></div><p class="info small">Live prices aren't available yet. They load from this site once it's online.</p></div>`;
    const g = FD.metalPerGram(feedData, 'gold', state.market), sv = FD.metalPerGram(feedData, 'silver', state.market);
    const usd = feedData.fx?.pkr?.USD;
    const st = k => (feedData.stale || []).includes(k) ? ' <span class="badge">stale</span>' : '';
    return `<div class="card mkt">
      <div class="class-head"><span class="t">Market today</span><span class="muted small">updated ${ago(feedData.updated)}</span></div>
      <div class="kpis mkt-kpis">
        <div class="kpi"><div class="k">USD / PKR${st('fx')}</div><div class="v">${usd ? qty(usd) : '—'}</div></div>
        <div class="kpi"><div class="k">Gold 24K / tola${st('gold')}</div><div class="v">${g ? money(g.perGram * FD.TOLA_G) : '—'}</div></div>
        <div class="kpi"><div class="k">Silver / tola${st('silver')}</div><div class="v">${sv ? money(sv.perGram * FD.TOLA_G) : '—'}</div></div>
        <div class="kpi"><div class="k">PSX closes${st('psx')}</div><div class="v small-v">${feedData.psx ? feedData.psx.count + ' · ' + fmtDate(feedData.psx.date) : 'unavailable'}</div></div>
        <div class="kpi"><div class="k">Fund NAVs${st('funds')}</div><div class="v small-v">${feedData.funds ? feedData.funds.count + ' · ' + fmtDate(feedData.funds.latest_date) : 'unavailable'}</div></div>
      </div>
      <p class="info small">${g ? 'Gold: ' + esc(g.source) + '. ' : ''}<button class="link" data-goto="data">Sources & settings</button>${feedData.psx ? ' · <button class="link" id="mkt-psx">PSX shares</button>' : ''}${feedData.funds ? ' · <button class="link" id="mkt-navs">Fund NAVs</button>' : ''}</p>
    </div>`;
  }

  function wireMarketCard(el) {
    $$('[data-goto]', el).forEach(b => b.onclick = () => showView(b.dataset.goto));
    if ($('#mkt-navs', el)) $('#mkt-navs', el).onclick = () => openNavBrowser();
    if ($('#mkt-psx', el)) $('#mkt-psx', el).onclick = () => openBrowser('psx');
  }

  function openNavBrowser() { openBrowser('funds'); }
  function openBrowser(kind) {
    const dlg = $('#dlg-navs');
    const isPsx = kind === 'psx';
    $('#nav-title').textContent = isPsx ? 'PSX shares' : 'Fund NAVs';
    const items = isPsx ? FD.psxList(feedData) : (feedData?.funds?.items || []);
    const groups = isPsx ? [...new Set(items.map(x => x.sector || 'Other'))].sort() : FD.amcList(feedData);
    $('#nav-amc').innerHTML = `<option value="">${isPsx ? 'All sectors' : 'All AMCs'}</option>` + groups.map(a => `<option>${esc(a)}</option>`).join('');
    $('#nav-meta').textContent = isPsx ? (feedData?.psx ? `${feedData.psx.count} shares · closing prices ${fmtDate(feedData.psx.date)}` : '')
      : (feedData?.funds ? `${feedData.funds.count} funds from MUFAP · latest ${fmtDate(feedData.funds.latest_date)}` : '');
    $('#nav-q').placeholder = isPsx ? 'Search symbol, company or sector' : 'Search fund, AMC or category';
    const draw = () => {
      const q = $('#nav-q').value.trim().toLowerCase(), g = $('#nav-amc').value;
      let list, tracked;
      if (isPsx) {
        list = items.filter(x => (!g || (x.sector || 'Other') === g) && (!q || (x.symbol + ' ' + (x.name || '') + ' ' + (x.sector || '')).toLowerCase().includes(q)));
        if (q) list.sort((a, b) => (b.symbol.toLowerCase() === q) - (a.symbol.toLowerCase() === q) || (b.symbol.toLowerCase().startsWith(q)) - (a.symbol.toLowerCase().startsWith(q)));
        tracked = new Set(state.holdings.filter(h => h.feed?.type === 'psx').map(h => h.feed.symbol.toUpperCase()));
        $('#nav-list').innerHTML = list.slice(0, 150).map(x => `<div class="li"><div><b>${esc(x.symbol)}</b>${x.name ? ' · ' + esc(x.name) : ''}<br><span class="muted">${esc(x.sector || '')}${x.volume ? ' · vol ' + nf0.format(x.volume) : ''}</span></div>
          <div class="right"><b>${qty(x.current)}</b><br><span class="small ${sign(x.change_pct)}">${x.change_pct != null ? (x.change_pct >= 0 ? '+' : '') + x.change_pct.toFixed(2) + '%' : ''}</span><br>${tracked.has(x.symbol) ? '<span class="muted small">tracked</span>' : `<button class="link" data-track="${esc(x.symbol)}">Track</button>`}</div></div>`).join('');
      } else {
        list = items.filter(f => (!g || (f.amc || 'Other') === g) && (!q || (f.fund + ' ' + f.category + ' ' + f.amc).toLowerCase().includes(q)));
        tracked = new Set(state.holdings.filter(h => h.feed?.type === 'mufap').map(h => h.feed.fund.toLowerCase()));
        $('#nav-list').innerHTML = list.slice(0, 150).map(f => `<div class="li"><div><b>${esc(f.fund)}</b><br><span class="muted">${esc(f.category || '')}${f.amc ? ' · ' + esc(f.amc) : ''}</span></div>
          <div class="right"><b>${qty(f.nav)}</b><br><span class="muted small">${fmtDate(f.date)}</span><br>${tracked.has(f.fund.toLowerCase()) ? '<span class="muted small">tracked</span>' : `<button class="link" data-track="${esc(f.fund)}">Track</button>`}</div></div>`).join('');
      }
      $('#nav-list').innerHTML += (list.length > 150 ? `<p class="muted small">Showing 150 of ${list.length} — refine the search.</p>` : '') + (list.length ? '' : '<p class="muted">Nothing matches.</p>');
      $$('[data-track]', $('#nav-list')).forEach(b => b.onclick = () => {
        dlg.close();
        const k = b.dataset.track;
        openHolding(null, null, isPsx ? { name: k, cls: 'psx', symbol: k, feed: { type: 'psx', symbol: k } } : { name: k, cls: 'mf', feed: { type: 'mufap', fund: k } });
      });
    };
    $('#nav-q').oninput = draw; $('#nav-amc').onchange = draw; $('#nav-q').value = '';
    draw(); closeOn(dlg); dlg.showModal();
  }

  function marketSettingsHTML() {
    const m = state.market;
    const metal = (k, label) => `<div class="mkt-set">
        <label class="zk-field">${label} rate source
          <select data-mk="${k}.source"><option value="spot">International spot (gold-api.com) × USD/PKR</option><option value="manual">My own rate (e.g. local Sarafa)</option></select></label>
        <div data-show="${k}.spot"><label class="zk-field">Local premium over spot (%)<input type="number" step="any" inputmode="decimal" data-mk="${k}.premiumPct" value="${esc(m[k].premiumPct)}" placeholder="0"></label></div>
        <div data-show="${k}.manual"><label class="zk-field">${label} 24K price per tola (PKR)<input type="number" step="any" min="0" inputmode="decimal" data-mk="${k}.manualTola" value="${esc(m[k].manualTola)}"></label></div>
      </div>`;
    return `<div class="card">
        <p class="info">Prices refresh on weekdays (three times) and Saturday on this site from public sources, then load on your phone. No personal data is sent anywhere.</p>
        <label class="zk-check"><input type="checkbox" id="mk-auto" ${m.autoApply ? 'checked' : ''}><span>Update linked holdings automatically when the app opens</span></label>
        <div class="btn-grid gap-top"><button class="primary" id="mk-refresh">Refresh & apply now</button><button class="ghost" id="mk-navs">Browse fund NAVs</button></div>
        <button class="link" id="mk-psx">Browse PSX shares</button>
      </div>
      <div class="card">
        <b>PSX share prices (private)</b>
        <p class="info small">PSX restricts redistribution of its market data, so this site publishes PSX prices only as an encrypted file. Enter the same passphrase you saved as the repo's <code>PSX_DATA_KEY</code> secret; it stays on this device.
        ${feedData?.psx ? `<br><span class="pos">Unlocked · ${feedData.psx.count} shares · ${fmtDate(feedData.psx.date)}</span>` : feedData?.psxError ? '<br><span class="neg">That passphrase did not unlock the file.</span>' : feedData?.psx_private?.available ? '<br>Encrypted prices are available on this site.' : '<br>Not enabled on this site yet.'}</p>
        <label class="zk-field">Passphrase<input type="password" id="mk-psxkey" autocomplete="off" placeholder="${feedData?.psx ? '•••••• (saved)' : ''}"></label>
        <button class="ghost" id="mk-psxsave">Save & unlock</button>
      </div>
      <div class="card">
        ${metal('gold', 'Gold')}
        ${metal('silver', 'Silver')}
        <label class="zk-field">Default PSX broker (for trade charges)
          <select data-mk="broker">${Object.entries(window.Charges.BROKERS).map(([k, b]) => `<option value="${k}">${esc(b.name)}</option>`).join('')}</select></label>
        <label class="zk-field">Mutual fund price to use
          <select data-mk="navField"><option value="nav">NAV</option><option value="repurchase">Repurchase (what you'd get on redemption)</option></select></label>
      </div>
      <div class="card list-mini">
        <div class="li"><div><b>PSX share prices</b><br><span class="muted">PSX Data Portal market watch (closing / last prices)</span></div><a class="chip-link" href="https://dps.psx.com.pk/market-watch" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
        <div class="li"><div><b>Mutual fund NAVs</b><br><span class="muted">MUFAP daily NAV & sales-load table, all AMCs</span></div><a class="chip-link" href="https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
        <div class="li"><div><b>Gold & silver spot</b><br><span class="muted">gold-api.com (USD per troy ounce)</span></div><a class="chip-link" href="https://gold-api.com" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
        <div class="li"><div><b>Exchange rates</b><br><span class="muted">ExchangeRate-API open access (mid-market)</span></div><a class="chip-link" href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Open ↗</a></div>
        <p class="muted small">TradingView isn't used: its terms allow its prices for on-screen display only, not for apps that process them. Spot gold is the international price; local Sarafa rates are usually higher — set a premium or enter your own rate.</p>
      </div>`;
  }

  function wireMarketSettings(el) {
    const m = state.market;
    const sync = () => {
      for (const k of ['gold', 'silver']) $$(`[data-show^="${k}."]`, el).forEach(d => { d.hidden = d.dataset.show !== `${k}.${m[k].source}`; });
    };
    $$('[data-mk]', el).forEach(inp => {
      const [a, b] = inp.dataset.mk.split('.');
      inp.value = b ? m[a][b] : m[a];
      inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', async () => {
        if (b) { m[a][b] = inp.value; if (b === 'manualTola') m[a].manualDate = today(); } else m[a] = inp.value;
        sync(); await save(); renderOverview();
      });
    });
    $('#mk-psxsave', el).onclick = async () => {
      const v = $('#mk-psxkey', el).value;
      if (!v) { toast('Enter the passphrase'); return; }
      await Store.set('psxkey', v);
      feedData = feedData || {}; delete feedData.psxError;
      const ok = await loadPsx(true);
      if (ok) { const n = applyFeed(); await save(); renderAll(); toast(`PSX prices unlocked${n ? ` · ${n} holdings updated` : ''}`); }
      else { renderData(); toast(feedData.psxError ? 'Wrong passphrase' : 'No encrypted PSX prices on the site yet'); }
    };
    $('#mk-auto', el).onchange = async e => { m.autoApply = e.target.checked; await save(); };
    $('#mk-refresh', el).onclick = async () => {
      await loadFeed(true);
      if (!feedData) { toast('Could not load prices — check your connection'); return; }
      const n = applyFeed(); await save(); renderAll();
      toast(n ? `Updated prices for ${n} holding${n > 1 ? 's' : ''}` : 'Prices loaded — holdings already up to date');
    };
    $('#mk-navs', el).onclick = () => (feedData?.funds ? openNavBrowser() : toast('Fund NAVs are not available yet'));
    $('#mk-psx', el).onclick = () => (feedData?.psx ? openBrowser('psx') : toast('PSX prices are not available yet'));
    sync();
  }

  // Holding dialog: link to a price feed
  function setupFeedPicker(f, preset) {
    const typeSel = $('#feed-type'), amcSel = $('#feed-amc'), fundSel = $('#feed-fund');
    const fundsBy = amc => (feedData?.funds?.items || []).filter(x => !amc || (x.amc || 'Other') === amc);
    amcSel.innerHTML = '<option value="">All AMCs</option>' + FD.amcList(feedData).map(a => `<option>${esc(a)}</option>`).join('');
    const fillFunds = keep => {
      const list = fundsBy(amcSel.value);
      fundSel.innerHTML = list.length ? list.map(x => `<option>${esc(x.fund)}</option>`).join('') : '<option value="">(no fund list loaded yet)</option>';
      if (keep && list.some(x => x.fund === keep)) fundSel.value = keep;
    };
    $('#feed-fx-code').innerHTML = FX_CODES.map(c => `<option>${c}</option>`).join('');
    $('#feed-psx-list').innerHTML = FD.psxList(feedData).map(x => `<option value="${esc(x.symbol)}">${esc(x.name || x.sector || '')}</option>`).join('');
    const cur = preset || null;
    $('#feed-psx-sym').value = cur?.type === 'psx' ? cur.symbol : '';
    typeSel.value = cur?.type || '';
    if (cur?.type === 'mufap') {
      const it = FD.findFund(feedData, cur.fund);
      amcSel.value = it ? (it.amc || 'Other') : '';
      fillFunds(it ? it.fund : cur.fund);
      if (!it && cur.fund) fundSel.innerHTML = `<option>${esc(cur.fund)}</option>` + fundSel.innerHTML, fundSel.value = cur.fund;
    } else fillFunds();
    $('#feed-metal-k').value = cur?.metal || 'gold';
    $('#feed-karat').value = String(cur?.karat || 24);
    $('#feed-fx-code').value = cur?.code || 'USD';
    const read = () => {
      const t = typeSel.value;
      if (t === 'psx') { const sym = $('#feed-psx-sym').value.trim().toUpperCase(); return sym ? { type: 'psx', symbol: sym } : null; }
      if (t === 'mufap') return fundSel.value ? { type: 'mufap', fund: fundSel.value } : null;
      if (t === 'metal') return { type: 'metal', metal: $('#feed-metal-k').value, karat: $('#feed-metal-k').value === 'gold' ? +$('#feed-karat').value : null };
      if (t === 'fx') return { type: 'fx', code: $('#feed-fx-code').value };
      return null;
    };
    const preview = () => {
      $('#feed-mufap').hidden = typeSel.value !== 'mufap';
      $('#feed-psx').hidden = typeSel.value !== 'psx';
      $('#feed-metal').hidden = typeSel.value !== 'metal';
      $('#feed-karat-wrap').hidden = $('#feed-metal-k').value !== 'gold';
      $('#feed-fx').hidden = typeSel.value !== 'fx';
      const cfg = read();
      const lp = cfg ? FD.priceFor(feedData, cfg, f.unit.value, state.market) : null;
      $('#feed-preview').textContent = !cfg ? (typeSel.value ? '' : 'You will enter prices yourself on the Update tab.')
        : lp ? `Latest: ${qty(lp.price)} per ${(f.unit.value || 'unit').replace(/s$/i, '')} · ${fmtDate(lp.date)} · ${lp.source}`
        : (cfg.type === 'metal' && !FD.gramsPerUnit(f.unit.value) ? 'Set the unit name to tola, gram, ounce or kg.' : cfg.type === 'psx' && feedData?.psx ? 'Symbol not found in today’s PSX list.' : 'No price available right now.');
      if (cfg?.type === 'psx' && !f.name.value.trim()) f.name.value = cfg.symbol;
      if (cfg?.type === 'psx' && !f.symbol.value.trim()) f.symbol.value = cfg.symbol;
      if (cfg?.type === 'mufap' && !f.name.value.trim()) f.name.value = cfg.fund;
    };
    amcSel.onchange = () => { fillFunds(); preview(); };
    [typeSel, fundSel, $('#feed-metal-k'), $('#feed-karat'), $('#feed-fx-code'), $('#feed-psx-sym')].forEach(x => x.onchange = preview);
    $('#feed-psx-sym').oninput = () => { if ($('#feed-psx-sym').value.trim().length >= 2) preview(); };
    f.unit.addEventListener('input', preview);
    preview();
    return { read, preview, setDefault: cls => {
      if (typeSel.value) return;
      typeSel.value = cls === 'psx' ? 'psx' : cls === 'mf' && feedData?.funds ? 'mufap' : cls === 'gold' ? 'metal' : cls === 'fx' ? 'fx' : '';
      if (cls === 'psx' && !$('#feed-psx-sym').value) $('#feed-psx-sym').value = (f.symbol.value || f.name.value || '').trim().toUpperCase().split(/\s/)[0];
      if (cls === 'fx') f.unit.value = $('#feed-fx-code').value;
      preview();
    } };
  }

  // ---------- dialogs ----------
  function closeOn(dlg) { $$('[data-close]', dlg).forEach(b => b.onclick = () => dlg.close()); }

  let editingHolding = null;
  function openHolding(h = null, afterSave, preset = null) {
    editingHolding = h;
    const dlg = $('#dlg-holding'), f = $('#form-holding');
    $('#holding-title').textContent = h ? 'Edit holding' : 'New holding';
    $('#holding-cls').innerHTML = Object.entries(CLASSES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
    f.reset();
    const src = h || preset || {};
    f.name.value = src.name || ''; f.cls.value = src.cls || 'psx'; f.symbol.value = src.symbol || '';
    f.mode.value = src.mode || CLASSES[f.cls.value].mode; f.unit.value = src.unit ?? CLASSES[f.cls.value].unit; f.notes.value = src.notes || '';
    f.mode.disabled = !!(h && state.txns.some(t => t.hid === h.id));
    const picker = setupFeedPicker(f, src.feed);
    const syncUnit = () => { $('#holding-unit-wrap').hidden = f.mode.value !== 'units'; $('#feed-wrap').hidden = f.mode.value !== 'units'; };
    f.cls.onchange = () => { if (!f.mode.disabled) f.mode.value = CLASSES[f.cls.value].mode; f.unit.value = CLASSES[f.cls.value].unit; syncUnit(); picker.setDefault(f.cls.value); picker.preview(); };
    f.mode.onchange = syncUnit; syncUnit();
    if (!h && !preset) picker.setDefault(f.cls.value);
    f.onsubmit = async e => {
      e.preventDefault();
      const name = f.name.value.trim();
      if (!name) return;
      if (state.holdings.some(x => x.name.toLowerCase() === name.toLowerCase() && x !== h)) { toast('A holding with that name already exists'); return; }
      const feed = f.mode.value === 'units' ? picker.read() : null;
      const data = { name, cls: f.cls.value, symbol: f.symbol.value.trim(), mode: f.mode.value, unit: f.mode.value === 'units' ? f.unit.value.trim() : '', notes: f.notes.value.trim(), feed };
      let target = h;
      if (h) Object.assign(h, data); else { target = { id: uid(), ...data }; state.holdings.push(target); }
      if (feed) applyFeed();
      await save(); dlg.close(); renderAll();
      if (afterSave) afterSave(target);
      else if (!h) openTxn(target.id);
    };
    closeOn(dlg); dlg.showModal();
  }

  let editingTxn = null;
  function openTxn(hid = null, txn = null) {
    if (!state.holdings.length) { openHolding(); return; }
    editingTxn = txn;
    const dlg = $('#dlg-txn'), f = $('#form-txn');
    $('#txn-title').textContent = txn ? 'Edit transaction' : 'Add transaction';
    f.reset();
    $('#txn-hid').innerHTML = state.holdings.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map(h => `<option value="${h.id}">${esc(h.name)} · ${CLASSES[h.cls].label}</option>`).join('') + '<option value="__new">+ New holding…</option>';
    f.hid.value = txn?.hid || hid || state.holdings[0].id;
    f.date.value = txn?.date || today();
    setNum(f.amount, txn?.amount ?? null, 2); setNum(f.units, txn?.units ?? null, 6); f.note.value = txn?.note || '';
    const sync = () => {
      if (f.hid.value === '__new') { dlg.close(); openHolding(null, h => openTxn(h.id)); return; }
      const h = state.holdings.find(x => x.id === f.hid.value);
      const prev = f.type.value;
      f.type.innerHTML = TYPES[h.mode].map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
      f.type.value = (txn && txn.hid === h.id ? txn.type : TYPES[h.mode].some(t => t[0] === prev) ? prev : 'BUY');
      syncType(h);
    };
    const C = window.Charges;
    $('#txn-broker').innerHTML = Object.entries(C.BROKERS).map(([k, b]) => `<option value="${k}">${esc(b.name)}</option>`).join('');
    $('#txn-broker').value = txn?.broker || state.market?.broker || 'psx-minimum';
    setNum($('#txn-price'), txn?.price ?? null);
    let priceAuto = false, unitsTouched = !!txn;
    const priceMode = h => h && h.mode === 'units' && (f.type.value === 'BUY' || f.type.value === 'SELL') ? (h.cls === 'psx' ? 'psx' : 'unit') : null;
    // Latest market price for this holding — usable only when the entry date is on/after the price date.
    const feedPriceForDate = h => {
      if (!h?.feed || !feedData) return null;
      const buy = f.type.value === 'BUY';
      if (h.feed.type === 'mufap') {
        const it = FD.findFund(feedData, h.feed.fund);
        if (!it) return null;
        if (f.date.value && it.date && f.date.value < it.date) return { old: true, date: it.date };
        const p = buy ? (it.offer || it.nav) : (it.repurchase || it.nav);
        const label = buy && it.offer && it.offer !== it.nav ? 'offer price (NAV + front-end load)' : !buy && it.repurchase && it.repurchase !== it.nav ? 'repurchase price' : 'NAV';
        return { price: p, date: it.date, label: 'MUFAP ' + label };
      }
      const lp = livePrice(h);
      if (!lp) return null;
      if (f.date.value && lp.date && f.date.value < lp.date) return { old: true, date: lp.date };
      return { price: lp.price, date: lp.date, label: lp.source };
    };
    let priceNote = '';
    const fillPrice = h => {
      const fp = feedPriceForDate(h);
      const isMf = h.cls === 'mf';
      if (fp && fp.price && (priceAuto || !$('#txn-price').value)) {
        setNum($('#txn-price'), fp.price); priceAuto = true;
        priceNote = `Filled from ${fp.label} for ${fmtDate(fp.date)}.`;
      } else if (priceAuto && (!fp || fp.old)) {
        $('#txn-price').value = ''; priceAuto = false;
      }
      if (!priceAuto) {
        priceNote = fp?.old
          ? `<span class="old-date">Older date — enter the ${isMf ? 'NAV (or offer price you paid)' : 'price'} for ${fmtDate(f.date.value)} yourself${isMf ? ', from your fund statement or MUFAP' : ''}. Latest available is ${fmtDate(fp.date)}.</span>`
          : h.feed ? '' : `Enter the ${isMf ? 'NAV / offer price' : 'price'} you ${f.type.value === 'SELL' ? 'sold' : 'bought'} at.`;
      }
    };
    const calc = () => {
      const h = state.holdings.find(x => x.id === f.hid.value);
      const mode = priceMode(h);
      if (!mode) return;
      const qn = num(f.units.value), pr = num($('#txn-price').value), amt = num(f.amount.value);
      const out = $('#txn-calc');
      if (mode === 'psx') {
        if (!(qn > 0) || !(pr > 0)) { out.innerHTML = (priceNote ? priceNote + '<br>' : '') + 'Enter shares and price to work out charges, or type the total from your contract note.'; return; }
        const c = C.tradeCharges($('#txn-broker').value, f.type.value === 'SELL' ? 'sell' : 'buy', qn, pr);
        setNum(f.amount, c.net, 2);
        out.innerHTML = (priceNote ? priceNote + '<br>' : '') + `Value ${money(c.value)} · commission ${money(c.commission)} · SST ${money(c.taxes)} · CDC/levies ${money(c.other)} → ${f.type.value === 'SELL' ? 'you receive' : 'you pay'} <b>${money(c.net)}</b>. Estimate — your contract note wins.`;
        return;
      }
      let line = '';
      if (pr > 0 && amt > 0 && !unitsTouched) {
        const u = amt / pr;
        setNum(f.units, u, 4);
        line = `${groupNum(String(amt))} ÷ ${groupNum(String(pr))} = <b>${groupNum(u.toFixed(4))} ${esc(h.unit || 'units')}</b>`;
      } else if (pr > 0 && qn > 0 && !(amt > 0)) {
        setNum(f.amount, qn * pr, 2);
        line = `${groupNum(String(qn))} × ${groupNum(String(pr))} = <b>${money(qn * pr)}</b>`;
      } else if (unitsTouched && qn > 0 && amt > 0) {
        line = `Implied price: <b>${groupNum((amt / qn).toFixed(4))}</b> per ${esc((h.unit || 'unit').replace(/s$/i, ''))}. Clear Units to recalculate from the price.`;
      }
      out.innerHTML = [priceNote, line].filter(Boolean).join('<br>');
    };
    $('#txn-price').addEventListener('input', () => { priceAuto = false; priceNote = ''; calc(); });
    $('#txn-broker').onchange = calc;
    f.amount.addEventListener('input', () => { const h = state.holdings.find(x => x.id === f.hid.value); if (priceMode(h) === 'unit') calc(); });
    f.units.addEventListener('input', () => { unitsTouched = f.units.value.trim() !== ''; calc(); });
    f.date.addEventListener('change', () => { const h = state.holdings.find(x => x.id === f.hid.value); if (priceMode(h)) { fillPrice(h); calc(); } });
    const syncTrade = h => {
      const mode = priceMode(h);
      $('#txn-trade').hidden = !mode;
      if (!mode) return;
      const unit = (h.unit || 'unit').replace(/s$/i, '');
      $('#txn-trade-legend').textContent = mode === 'psx' ? 'PSX trade' : h.cls === 'mf' ? 'NAV & units' : 'Price & quantity';
      $('#txn-price-label').textContent = mode === 'psx' ? 'Price per share (PKR)' : h.cls === 'mf' ? `NAV / offer price per ${unit} (PKR)` : `Price per ${unit} (PKR)`;
      $('#txn-broker-wrap').hidden = mode !== 'psx';
      $('#txn-price').placeholder = mode === 'psx' ? 'e.g. 253.50' : h.cls === 'mf' ? 'e.g. 154.0400' : 'e.g. 413,305';
      f.units.placeholder = mode === 'psx' ? 'e.g. 500' : h.cls === 'mf' ? 'worked out from amount ÷ NAV' : 'e.g. 1.5';
      if (!txn) fillPrice(h);
      calc();
    };
    const syncType = h => {
      syncTrade(h);
      const t = f.type.value, u = h.mode === 'units';
      const needUnits = u && (t === 'BUY' || t === 'SELL' || t === 'REINVEST');
      $('#txn-units-wrap').hidden = !needUnits;
      $('#txn-units-label').textContent = `${t === 'REINVEST' ? 'Units added' : h.cls === 'psx' ? 'Shares' : 'Units'}${h.unit && !/^(units?|shares?)$/i.test(h.unit) ? ' (' + h.unit + ')' : ''}`;
      $('#txn-amount-label').textContent = {
        BUY: u ? (h.cls === 'psx' ? 'Total paid incl. charges (PKR)' : h.cls === 'mf' ? 'Amount invested (PKR)' : 'Total paid (PKR)') : 'Amount deposited (PKR)',
        SELL: u ? 'Total received after charges (PKR)' : 'Amount withdrawn (PKR)',
        INCOME: 'Amount received (PKR, after tax)', REINVEST: 'Amount (optional, info only)', FEE: 'Amount paid (PKR)',
      }[t];
      f.amount.required = t !== 'REINVEST'; f.units.required = needUnits;
      $('#txn-hint').textContent = {
        BUY: u ? '' : 'Money you moved into this account.',
        SELL: u ? '' : 'Money you took out of this account.',
        INCOME: u ? 'Cash dividends or payouts that reached your bank. Reinvested payouts go under “Bonus / reinvested units”.' : 'Only if profit was paid to another account. If it was credited to this account, just update the balance.',
        REINVEST: 'Bonus shares or reinvested dividends: adds units without new cash.',
        FEE: 'Charges paid separately (e.g. CDC fees). Skip if already included in a buy amount.',
      }[t];
    };
    f.hid.onchange = sync;
    f.type.onchange = () => syncType(state.holdings.find(x => x.id === f.hid.value));
    f.type.value = '';
    sync();
    f.onsubmit = async e => {
      e.preventDefault();
      const h = state.holdings.find(x => x.id === f.hid.value);
      const rec = { hid: h.id, date: f.date.value, type: f.type.value, amount: num(f.amount.value) ?? 0, units: $('#txn-units-wrap').hidden ? null : num(f.units.value), note: f.note.value.trim() };
      if (!$('#txn-trade').hidden && num($('#txn-price').value) > 0) {
        rec.price = num($('#txn-price').value);
        if (!$('#txn-broker-wrap').hidden) { rec.broker = $('#txn-broker').value; state.market.broker = rec.broker; }
      }
      if (rec.type === 'SELL' && h.mode === 'units') {
        const s = holdingStats(h);
        const held = s.units + (txn && txn.type === 'SELL' && txn.hid === h.id ? (num(txn.units) || 0) : 0) - (txn && txn.hid === h.id && (txn.type === 'BUY' || txn.type === 'REINVEST') ? (num(txn.units) || 0) : 0);
        if ((rec.units || 0) > held + 1e-9 && !confirm(`You hold ${qty(held)} units but are selling ${qty(rec.units)}. Save anyway?`)) return;
      }
      if (txn) Object.assign(txn, rec); else state.txns.push({ id: uid(), ...rec });
      await save(); dlg.close(); renderAll();
      if ($('#dlg-detail').open) openDetail(h.id);
      toast('Saved');
    };
    closeOn(dlg); dlg.showModal();
  }

  function openDetail(hid) {
    const h = state.holdings.find(x => x.id === hid);
    if (!h) return;
    const s = holdingStats(h);
    const typeLabel = t => (TYPES[h.mode].find(x => x[0] === t) || [, t])[1];
    const body = $('#detail-body');
    body.innerHTML = `
      <div class="detail-head">
        <div><h2>${esc(h.name)}</h2><div class="muted small"><i class="dot bg-${h.cls}"></i>${CLASSES[h.cls].label}${h.symbol ? ' · ' + esc(h.symbol) : ''}</div></div>
        <button class="x" aria-label="Close" id="det-close">×</button>
      </div>
      <div class="card gap-top">
        <div class="kpis">
          <div class="kpi"><div class="k">Current value</div><div class="v">${money(s.value)}</div></div>
          <div class="kpi"><div class="k">Gain</div><div class="v ${sign(s.gain)}">${money(s.gain)}</div></div>
          <div class="kpi"><div class="k">XIRR${s.short ? ' (&lt;1y)' : ''}</div><div class="v ${sign(s.xirr)}">${pct(s.xirr)}</div></div>
          <div class="kpi"><div class="k">CAGR (simple)</div><div class="v ${sign(s.cagr)}">${pct(s.cagr)}</div></div>
          <div class="kpi"><div class="k">Invested</div><div class="v">${money(s.invested)}</div></div>
          <div class="kpi"><div class="k">Received back</div><div class="v">${money(s.returned)}</div></div>
          ${h.mode === 'units' ? `<div class="kpi"><div class="k">Units held</div><div class="v">${qty(s.units)}</div></div>
          <div class="kpi"><div class="k">Price${s.priceSource === 'trade' ? ' (last trade)' : ''}</div><div class="v">${s.price != null ? qty(s.price) : '—'}</div></div>` : ''}
        </div>
        <p class="info small">${s.valDate ? 'Valued as of ' + fmtDate(s.valDate) : ''}${s.stale ? ' — <b>stale</b>, update it for accurate returns' : ''}</p>
      </div>
      <div class="btn-grid">
        <button class="primary" id="det-add">Add transaction</button>
        <button class="ghost" id="det-upd">Update ${h.mode === 'units' ? 'price' : 'balance'}</button>
      </div>
      <h3>Transactions</h3>
      <div class="list-mini">${s.tx.length ? s.tx.slice().reverse().map(t => `
        <div class="li"><div><b>${typeLabel(t.type)}</b> · ${fmtDate(t.date)}${t.note ? ' · <span class="muted">' + esc(t.note) + '</span>' : ''}<br>
          <span class="muted">${t.amount ? money(t.amount) : ''}${t.units ? ' · ' + qty(t.units) + ' ' + esc(h.unit || 'units') : ''}${t.units && t.amount && (t.type === 'BUY' || t.type === 'SELL') ? ' @ ' + qty(t2price(t)) : ''}</span></div>
          <div><button class="link" data-edit-tx="${t.id}">Edit</button><button class="del" data-del-tx="${t.id}" aria-label="Delete">×</button></div></div>`).join('') : '<p class="muted">None yet.</p>'}</div>
      <h3>${h.mode === 'units' ? 'Price' : 'Balance'} history</h3>
      <div class="list-mini">${s.vs.length ? s.vs.slice().reverse().map(v => `
        <div class="li"><div>${fmtDate(v.date)}</div><div>${h.mode === 'units' ? qty(v.price) : money(v.value)} <button class="del" data-del-val="${v.id}" aria-label="Delete">×</button></div></div>`).join('') : '<p class="muted">None yet.</p>'}</div>
      <h3>Holding</h3>
      <div class="btn-grid"><button class="ghost" id="det-edit">Edit details</button><button class="danger" id="det-del">Delete holding</button></div>
    `;
    const dlg = $('#dlg-detail');
    $('#det-close').onclick = () => dlg.close();
    $('#det-add').onclick = () => openTxn(h.id);
    $('#det-upd').onclick = () => quickUpdate(h, s);
    $('#det-edit').onclick = () => { dlg.close(); openHolding(h, () => openDetail(h.id)); };
    $('#det-del').onclick = async () => {
      if (!confirm(`Delete “${h.name}” and its ${s.tx.length} transactions and ${s.vs.length} updates?`)) return;
      state.holdings = state.holdings.filter(x => x.id !== h.id);
      state.txns = state.txns.filter(x => x.hid !== h.id);
      state.vals = state.vals.filter(x => x.hid !== h.id);
      await save(); dlg.close(); renderAll(); toast('Holding deleted');
    };
    $$('[data-del-tx]', body).forEach(b => b.onclick = async () => {
      if (!confirm('Delete this transaction?')) return;
      state.txns = state.txns.filter(t => t.id !== b.dataset.delTx); await save(); renderAll(); openDetail(h.id);
    });
    $$('[data-edit-tx]', body).forEach(b => b.onclick = () => openTxn(h.id, state.txns.find(t => t.id === b.dataset.editTx)));
    $$('[data-del-val]', body).forEach(b => b.onclick = async () => {
      state.vals = state.vals.filter(v => v.id !== b.dataset.delVal); await save(); renderAll(); openDetail(h.id);
    });
    if (!dlg.open) dlg.showModal();
  }

  async function quickUpdate(h, s) {
    const label = h.mode === 'units' ? `Current price per ${h.unit || 'unit'} for ${h.name}` : `Current balance of ${h.name} (PKR)`;
    const cur = h.mode === 'units' ? s.price : s.value;
    const v = num(prompt(label, cur != null ? +(+cur).toFixed(4) : ''));
    if (v == null) return;
    const date = today();
    state.vals = state.vals.filter(x => !(x.hid === h.id && x.date === date));
    state.vals.push(h.mode === 'units' ? { id: uid(), hid: h.id, date, price: v } : { id: uid(), hid: h.id, date, value: v });
    await save(); renderAll(); openDetail(h.id); toast('Updated');
  }

  // ---------- export ----------
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Saved ' + name);
  }
  const hName = id => state.holdings.find(h => h.id === id)?.name || '';
  const hCls = id => state.holdings.find(h => h.id === id)?.cls || '';

  function exportTxCSV() {
    return F.toCSV(['date', 'holding', 'class', 'type', 'amount', 'units', 'note', 'price', 'broker'],
      state.txns.slice().sort(byDate).map(t => ({ ...t, holding: hName(t.hid), class: hCls(t.hid), units: t.units ?? '' })));
  }
  function exportValCSV() {
    return F.toCSV(['date', 'holding', 'price', 'value'],
      state.vals.slice().sort(byDate).map(v => ({ date: v.date, holding: hName(v.hid), price: v.price ?? '', value: v.value ?? '' })));
  }
  function exportHoldingsCSV() {
    return F.toCSV(['name', 'class', 'symbol', 'mode', 'unit', 'notes'], state.holdings.map(h => ({ ...h, class: h.cls })));
  }
  function exportSummaryCSV() {
    const { per, byClass, total } = allStats();
    const r = (label, cls, s) => ({
      holding: label, class: cls, units: s.units == null ? '' : +s.units.toFixed(6), price: s.price == null ? '' : +s.price.toFixed(4), value: s.value.toFixed(2), invested: s.invested.toFixed(2),
      received_back: s.returned.toFixed(2), gain: s.gain.toFixed(2), xirr_pct: s.xirr == null ? '' : (s.xirr * 100).toFixed(2),
      cagr_pct: s.cagr == null ? '' : (s.cagr * 100).toFixed(2), first_date: s.firstDate || '', valued_on: s.valDate || '',
    });
    const rows = per.map(s => r(s.h.name, CLASSES[s.h.cls].label, s));
    for (const k of Object.keys(byClass)) rows.push(r('TOTAL ' + CLASSES[k].label, CLASSES[k].label, byClass[k].agg));
    rows.push(r('TOTAL PORTFOLIO', 'All', total));
    return F.toCSV(['holding', 'class', 'units', 'price', 'value', 'invested', 'received_back', 'gain', 'xirr_pct', 'cagr_pct', 'first_date', 'valued_on'], rows);
  }

  // ---------- encrypted backup ----------
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function askPass(title, hint) {
    return new Promise(res => {
      const dlg = $('#dlg-pass'), f = $('#form-pass');
      $('#pass-title').textContent = title; $('#pass-hint').textContent = hint; f.reset();
      let done = false;
      f.onsubmit = e => { e.preventDefault(); done = true; dlg.close(); res(f.pass.value); };
      dlg.onclose = () => { if (!done) res(null); };
      closeOn(dlg); dlg.showModal();
    });
  }
  async function backup(share) {
    const pass = await askPass('Encrypt backup', 'Choose a passphrase. You will need it to restore. Leave empty for an unencrypted file (not recommended).');
    if (pass === null) return;
    let payload;
    if (pass) {
      if (!crypto.subtle) { toast('Encryption needs HTTPS — open the app from its https:// address'); return; }
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iterations = 310000;
      const key = await deriveKey(pass, salt, iterations);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(state)));
      payload = { format: 'pk-wealth-backup', v: 1, enc: 'AES-256-GCM/PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), data: b64(ct) };
    } else payload = { format: 'pk-wealth-backup', v: 1, enc: 'none', state };
    const name = `pkwealth-backup-${today()}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (share && navigator.canShare) {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'PK Wealth backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    download(name, blob);
  }
  async function restore(text) {
    let p;
    try { p = JSON.parse(text); } catch { toast('Not a valid backup file'); return; }
    if (p.format !== 'pk-wealth-backup') { toast('Not a PK Wealth backup'); return; }
    let next;
    if (p.enc === 'none') next = p.state;
    else {
      const pass = await askPass('Unlock backup', 'Enter the passphrase used when this backup was saved.');
      if (pass === null) return;
      try {
        const key = await deriveKey(pass, unb64(p.salt), p.iterations);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, key, unb64(p.data));
        next = JSON.parse(new TextDecoder().decode(pt));
      } catch { toast('Wrong passphrase or damaged file'); return; }
    }
    if (!next || !Array.isArray(next.holdings) || !Array.isArray(next.txns) || !Array.isArray(next.vals)) { toast('Backup content is not valid'); return; }
    if (state.holdings.length && !confirm(`Replace the ${state.holdings.length} holdings on this device with the ${next.holdings.length} in the backup?`)) return;
    state = { ...emptyState(), ...next, meta: { ...(next.meta || {}) } };
    await save(); renderAll(); showView('overview'); toast('Backup restored');
  }

  // ---------- CSV import ----------
  async function importCSV(text) {
    const rows = F.parseCSV(text);
    if (!rows.length) { toast('The file has no rows'); return; }
    const cols = Object.keys(rows[0]);
    const ensure = (name, cls) => {
      let h = state.holdings.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!h) {
        const c = CLASSES[cls] ? cls : guessClass(cls);
        h = { id: uid(), name, cls: c, symbol: '', mode: CLASSES[c].mode, unit: CLASSES[c].unit, notes: '' };
        state.holdings.push(h);
      }
      return h;
    };
    let added = 0, skipped = 0, bad = 0;
    if (cols.includes('type') && cols.includes('amount')) {
      for (const r of rows) {
        const type = TYPE_ALIASES[(r.type || '').toUpperCase()];
        const date = normDate(r.date);
        if (!type || !date || !r.holding) { bad++; continue; }
        const h = ensure(r.holding, (r.class || '').toLowerCase());
        const rec = { hid: h.id, date, type, amount: num(r.amount) ?? 0, units: num(r.units), note: r.note || '' };
        if (state.txns.some(t => t.hid === rec.hid && t.date === rec.date && t.type === rec.type && +t.amount === +rec.amount && (t.units ?? null) === rec.units)) { skipped++; continue; }
        state.txns.push({ id: uid(), ...rec }); added++;
      }
    } else if (cols.includes('price') || cols.includes('value')) {
      for (const r of rows) {
        const date = normDate(r.date);
        if (!date || !r.holding) { bad++; continue; }
        const h = ensure(r.holding, 'other');
        const price = num(r.price), value = num(r.value);
        if (price == null && value == null) { bad++; continue; }
        if (state.vals.some(v => v.hid === h.id && v.date === date)) { skipped++; continue; }
        state.vals.push(h.mode === 'units' ? { id: uid(), hid: h.id, date, price: price ?? value } : { id: uid(), hid: h.id, date, value: value ?? price });
        added++;
      }
    } else if (cols.includes('name') && cols.includes('class')) {
      for (const r of rows) {
        if (!r.name) { bad++; continue; }
        if (state.holdings.some(x => x.name.toLowerCase() === r.name.toLowerCase())) { skipped++; continue; }
        const c = CLASSES[(r.class || '').toLowerCase()] ? r.class.toLowerCase() : guessClass(r.class);
        state.holdings.push({ id: uid(), name: r.name, cls: c, symbol: r.symbol || '', mode: r.mode === 'value' || r.mode === 'units' ? r.mode : CLASSES[c].mode, unit: r.unit ?? CLASSES[c].unit, notes: r.notes || '' });
        added++;
      }
    } else { toast('Unrecognised columns: ' + cols.join(', ')); return; }
    await save(); renderAll();
    toast(`Imported ${added}` + (skipped ? `, skipped ${skipped} duplicates` : '') + (bad ? `, ${bad} rows unreadable` : ''));
  }
  function guessClass(s) {
    s = String(s || '').toLowerCase();
    if (/psx|stock|share|equit/.test(s)) return 'psx';
    if (/fund|mf|mufap|nav/.test(s)) return 'mf';
    if (/bank|saving|deposit|tdr|account/.test(s)) return 'bank';
    if (/gold|tola/.test(s)) return 'gold';
    return 'other';
  }
  function normDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY (Pakistan convention)
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  let pickMode = null;
  function pickFile(mode) {
    pickMode = mode;
    const inp = $('#file-input');
    inp.accept = mode === 'json' ? '.json,application/json' : '.csv,text/csv';
    inp.value = ''; inp.click();
  }
  $('#file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('File too large'); return; }
    const text = await file.text();
    if (pickMode === 'json' || /\.json$/i.test(file.name)) restore(text); else importCSV(text);
  });

  // ---------- sample data ----------
  async function loadSample() {
    const H = (name, cls, unit) => ({ id: uid(), name, cls, symbol: '', mode: CLASSES[cls].mode, unit: unit ?? CLASSES[cls].unit, notes: 'Sample' });
    const a = H('Sample PSX share', 'psx'), b = H('Sample income fund', 'mf'), c = H('Sample savings account', 'bank'), d = H('Gold (sample)', 'gold', 'tola');
    state.holdings.push(a, b, c, d);
    const T = (h, date, type, amount, units) => state.txns.push({ id: uid(), hid: h.id, date, type, amount, units: units ?? null, note: 'sample' });
    const V = (h, date, o) => state.vals.push({ id: uid(), hid: h.id, date, ...o });
    T(a, '2024-03-10', 'BUY', 120000, 1000); T(a, '2025-01-15', 'BUY', 90000, 500); T(a, '2025-09-20', 'INCOME', 9000);
    V(a, today(), { price: 260 });
    for (let m = 1; m <= 12; m++) T(b, `2025-${String(m).padStart(2, '0')}-05`, 'BUY', 25000, +(25000 / (100 + m * 1.4)).toFixed(4));
    V(b, today(), { price: 121 });
    T(c, '2024-07-01', 'BUY', 500000); T(c, '2025-06-01', 'SELL', 100000); V(c, today(), { value: 512000 });
    T(d, '2023-11-01', 'BUY', 215000, 1); V(d, today(), { price: 430000 });
    await save(); renderAll(); toast('Sample data loaded — delete the holdings when done');
  }

  // ---------- header: clock & themes ----------
  const THEMES = [
    { id: 'auto', label: 'Auto (follow phone)' }, { id: 'light', label: 'Light' }, { id: 'bluegray', label: 'Blue Gray' },
    { id: 'black', label: 'Black' }, { id: 'terminal', label: 'Terminal' }, { id: 'red', label: 'Red' },
  ];
  function tickClock() {
    const d = new Date();
    const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('#clock').innerHTML = `<b>${esc(time)}</b><br>${esc(date)}`;
  }
  function applyTheme(id) {
    const valid = THEMES.some(t => t.id === id) ? id : 'auto';
    document.documentElement.setAttribute('data-theme', valid);
    try { localStorage.setItem('pkw-theme', valid); } catch { }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f766e');
    $$('#theme-menu button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === valid)));
  }
  function setupThemes() {
    const btn = $('#theme-btn'), menu = $('#theme-menu');
    menu.innerHTML = THEMES.map(t => `<button role="menuitemradio" data-theme="${t.id}" aria-checked="false"><span class="swatch swatch-${t.id}"></span>${t.label}</button>`).join('');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
    $$('button', menu).forEach(b => b.onclick = () => { applyTheme(b.dataset.theme); close(); });
    document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    applyTheme(document.documentElement.getAttribute('data-theme'));
  }

  // ---------- boot ----------
  setupThemes(); tickClock(); setInterval(tickClock, 15000);
  enhanceNumbers(document);
  const APP_VERSION = '1.4.0';
  $$('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));
  $('#fab').onclick = () => openTxn();
  // close dialogs by tapping the backdrop
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  (async () => {
    await Store.open();
    const saved = await Store.get('state');
    if (saved && Array.isArray(saved.holdings)) state = { ...emptyState(), ...saved };
    normalizeMarket();
    try { feedData = (await Store.get('feed')) || null; } catch { }
    renderAll();
    loadFeed(false).then(async d => {
      if (!d) return;
      const n = state.market.autoApply ? applyFeed() : 0;
      if (n) await save();
      renderAll();
      if (n) toast(`Prices updated for ${n} holding${n > 1 ? 's' : ''}`);
    });
    try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) navigator.storage.persist(); } catch { }
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  })();
})();
