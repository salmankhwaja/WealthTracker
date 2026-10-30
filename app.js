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
  const num = v => (v === '' || v == null || !isFinite(+v)) ? null : +v;
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
    $$('[data-goto]', el).forEach(b => b.onclick = () => showView(b.dataset.goto));
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
            <div class="right"><div>${money(s.value)}</div><div class="sub">${metricLine(s)}</div></div>
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
      </div>
      ${Object.keys(CLASSES).map(k => {
        const list = active.filter(s => s.h.cls === k);
        if (!list.length) return '';
        return `<h3><i class="dot bg-${k}"></i>${CLASSES[k].label}</h3><div class="card">${list.map(s => {
          const cur = s.h.mode === 'units' ? s.price : s.value;
          return `<div class="row"><div class="name">${esc(s.h.name)}
              <div class="sub">${s.h.mode === 'units' ? `${qty(s.units)} ${esc(s.h.unit || '')} · price` : 'balance'} last set ${fmtDate(s.valDate)}</div></div>
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
    $('#asof').textContent = fmtDate(today());
    normalizeZakat();
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
        <p class="info small">Use today's rates from your jeweller or the Sarafa association.</p>
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

  // ---------- dialogs ----------
  function closeOn(dlg) { $$('[data-close]', dlg).forEach(b => b.onclick = () => dlg.close()); }

  let editingHolding = null;
  function openHolding(h = null, afterSave) {
    editingHolding = h;
    const dlg = $('#dlg-holding'), f = $('#form-holding');
    $('#holding-title').textContent = h ? 'Edit holding' : 'New holding';
    $('#holding-cls').innerHTML = Object.entries(CLASSES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
    f.reset();
    f.name.value = h?.name || ''; f.cls.value = h?.cls || 'psx'; f.symbol.value = h?.symbol || '';
    f.mode.value = h?.mode || CLASSES[f.cls.value].mode; f.unit.value = h?.unit ?? CLASSES[f.cls.value].unit; f.notes.value = h?.notes || '';
    f.mode.disabled = !!(h && state.txns.some(t => t.hid === h.id));
    const syncUnit = () => { $('#holding-unit-wrap').hidden = f.mode.value !== 'units'; };
    f.cls.onchange = () => { if (!f.mode.disabled) f.mode.value = CLASSES[f.cls.value].mode; f.unit.value = CLASSES[f.cls.value].unit; syncUnit(); };
    f.mode.onchange = syncUnit; syncUnit();
    f.onsubmit = async e => {
      e.preventDefault();
      const name = f.name.value.trim();
      if (!name) return;
      if (state.holdings.some(x => x.name.toLowerCase() === name.toLowerCase() && x !== h)) { toast('A holding with that name already exists'); return; }
      const data = { name, cls: f.cls.value, symbol: f.symbol.value.trim(), mode: f.mode.value, unit: f.mode.value === 'units' ? f.unit.value.trim() : '', notes: f.notes.value.trim() };
      let target = h;
      if (h) Object.assign(h, data); else { target = { id: uid(), ...data }; state.holdings.push(target); }
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
    f.amount.value = txn?.amount ?? ''; f.units.value = txn?.units ?? ''; f.note.value = txn?.note || '';
    const sync = () => {
      if (f.hid.value === '__new') { dlg.close(); openHolding(null, h => openTxn(h.id)); return; }
      const h = state.holdings.find(x => x.id === f.hid.value);
      const prev = f.type.value;
      f.type.innerHTML = TYPES[h.mode].map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
      f.type.value = (txn && txn.hid === h.id ? txn.type : TYPES[h.mode].some(t => t[0] === prev) ? prev : 'BUY');
      syncType(h);
    };
    const syncType = h => {
      const t = f.type.value, u = h.mode === 'units';
      const needUnits = u && (t === 'BUY' || t === 'SELL' || t === 'REINVEST');
      $('#txn-units-wrap').hidden = !needUnits;
      $('#txn-units-label').textContent = `${t === 'REINVEST' ? 'Units added' : 'Units'}${h.unit ? ' (' + h.unit + ')' : ''}`;
      $('#txn-amount-label').textContent = {
        BUY: u ? 'Total paid incl. commission (PKR)' : 'Amount deposited (PKR)',
        SELL: u ? 'Total received after charges (PKR)' : 'Amount withdrawn (PKR)',
        INCOME: 'Amount received (PKR, after tax)', REINVEST: 'Amount (optional, info only)', FEE: 'Amount paid (PKR)',
      }[t];
      f.amount.required = t !== 'REINVEST'; f.units.required = needUnits;
      $('#txn-hint').textContent = {
        BUY: u ? 'Price per unit is worked out from amount ÷ units.' : 'Money you moved into this account.',
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
    return F.toCSV(['date', 'holding', 'class', 'type', 'amount', 'units', 'note'],
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

  // ---------- boot ----------
  const APP_VERSION = '1.1.0';
  $$('.tabbar button').forEach(b => b.onclick = () => showView(b.dataset.view));
  $('#fab').onclick = () => openTxn();
  // close dialogs by tapping the backdrop
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  (async () => {
    await Store.open();
    const saved = await Store.get('state');
    if (saved && Array.isArray(saved.holdings)) state = { ...emptyState(), ...saved };
    renderAll();
    try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) navigator.storage.persist(); } catch { }
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  })();
})();
