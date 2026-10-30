# WealthTracker (PK Wealth)

Track your wealth — especially XIRR / CAGR and Zakat — in an app served from GitHub Pages, with your data kept on your own phone.

An offline-first Progressive Web App (PWA) for tracking a Pakistani portfolio in one place:

- **PSX shares**
- **Mutual funds (MUFAP)**
- **Bank savings and deposits**
- **Gold**
- **Anything else**

It calculates **XIRR** and **CAGR** per holding, per asset class and for the whole portfolio.

There are no accounts, servers or trackers. The data lives in the browser on your device (IndexedDB) and leaves only when you export it.

## Features

- **One app for every asset class.** Stocks, funds and gold are tracked as *units × price*. Bank accounts and other assets are tracked by *balance*.
- **Transaction types.** Buy/Deposit, Sell/Withdrawal, Dividend or profit received, Bonus/reinvested units, and Fee.
- **Update screen.** You enter every NAV, share price, gold rate and bank balance on one screen. Values older than 30 days are flagged as stale.
- **Returns.**
  - XIRR uses Excel's convention. It is verified against Microsoft's reference example in `tests/`.
  - The app also shows simple CAGR, absolute return and total gain.
- **Export.** CSV exports cover transactions, prices, holdings and a summary with XIRR and CAGR. They open in Excel, LibreOffice or Google Sheets.
- **Import.** CSV import accepts the same formats. It auto-creates holdings, skips duplicates and understands `DD/MM/YYYY` dates.
- **Encrypted backup.** The backup is a single file encrypted with AES-256-GCM, using a key derived with PBKDF2-SHA256 (310k iterations) through WebCrypto. Use it to move between phones and PCs. On Android you can share it straight to Syncthing, Drive or WhatsApp.
- **Works offline** through a service worker. Light and dark themes are supported.
- **Strict Content-Security-Policy.** No third-party code is loaded.

## Live prices

A GitHub Action (`.github/workflows/prices.yml`) runs `scripts/fetch_prices.py` three times a day and commits `data/prices.json`. The app reads that file from its own site, so no personal data is sent anywhere, and it works offline from the last copy.

| Data | Source | Notes |
|---|---|---|
| Mutual fund NAVs, all AMCs (NBP, Al Meezan, ABL, HBL, MCB, UBL, Alfalah…) | [MUFAP daily NAV table](https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3) | NAV, offer, repurchase, validity date |
| Gold & silver | [gold-api.com](https://gold-api.com) spot (USD/oz) × USD/PKR | Fallback: fawazahmed0 currency-api |
| USD, EUR, GBP, AED, SAR, CNY → PKR | [ExchangeRate-API open access](https://www.exchangerate-api.com) | Mid-market rate |

In the app:

- **Link a holding** (Edit holding → Auto price) to a MUFAP fund, gold or silver (24/22/21/18K, unit in tola, gram, ounce or kg), or a currency.
- **Browse fund NAVs** from the Overview's *Market today* card and tap **Track** to add a fund.
- **Automatic updates.** Linked holdings get a dated price when the app opens. A price you typed yourself is never overwritten. You can switch this off on the Data tab.
- **Gold rate choice** (Data tab):
  - International spot, optionally with a local premium %.
  - Your own rate, for example the Sarafa rate.
- **Zakat → Use market rates** fills gold and silver for nisab.

TradingView is deliberately not used: its terms license prices for on-screen display only and prohibit automated processing.

## XIRR vs CAGR

- **XIRR** weights every cash flow by its date. Use it whenever you invested in instalments (SIPs), topped up or withdrew money.
- **CAGR (simple)** is `((value now + cash received) / total invested)^(1/years) − 1`, measured from your first investment. It is exact only for a single lump sum. When money went in over time, it understates the return.
- Both figures are marked `<1y` when the history is shorter than a year. Annualising a few months magnifies small moves.

### How cash flows are counted

| Type | Cash flow for XIRR |
|---|---|
| Buy / Deposit | − amount (money you put in) |
| Fee | − amount |
| Sell / Withdrawal | + amount |
| Dividend / profit received | + amount (only if it reached your bank) |
| Bonus / reinvested units | none — units go up |
| Current value | + value as of today |

For a bank account whose profit is credited into the account itself, do not record the profit. Update the balance instead, and the growth shows up as return.

## Zakat

Rules follow common Hanafi practice in Pakistan (as TCF's calculator does):

- Zakatable: cash and bank balances, investments (shares, funds, certificates), gold and silver, receivables, trade goods.
- Nisab: if all zakatable wealth is gold, the gold nisab applies; for any mix, the lower silver nisab applies. You can force either.
- Due: 2.5% of net (assets − debts due now) held for a lunar year, if at or above nisab. Gregorian-year option uses 2.5775%.
- Zakat deducted at source by banks/funds on 1 Ramadan (no CZ-50 filed) is subtracted so you don't pay twice.
- Shares can be counted below 100% if you follow the view that only a company's zakatable assets count.

It is a calculator, not a ruling — consult a scholar for your situation. Gold and silver rates are entered by you (the gold rate defaults to your gold holding's latest price).

Default charity links: [Shaukat Khanum — Zakat](https://shaukatkhanum.org.pk/donors/zakat/), [Zindagi Trust — Donate](https://www.zindagitrust.org/donate), [TCF — Zakat](https://www.tcf.org.pk/zakat-calculator/). For an income-tax credit, the organisation must be FBR-approved under section 2(36): ask for its current approval certificate and an NTN receipt ([FBR](https://www.fbr.gov.pk), [PCP certification](https://pcp.org.pk)).

## Deploy (GitHub Pages)

```bash
git remote add origin git@github.com:salmankhwaja/WealthTracker.git
git push -u origin main
```

1. In the repo, go to **Settings → Pages → Build from branch → `main` / root**.
2. Open `https://salmankhwaja.github.io/WealthTracker/` in Chrome on Android.
3. Use **⋮ → Add to Home screen / Install app**.

Install it on each device the same way. Each install has its **own** data. To carry data across, use **Data → Save backup** on one device and **Restore backup** on the other.

The repo can be private if you have GitHub Pro. Otherwise the *code* is public, but your *data* never is, because it is never in the repo.

### Run locally

```bash
python3 -m http.server 8080    # then open http://localhost:8080
node tests/finance.test.js     # unit tests for XIRR / CAGR / CSV
node tests/zakat.test.js       # unit tests for nisab / Zakat
```

## Keeping devices in step

| Method | How |
|---|---|
| Manual | Save backup → send the file → Restore backup on the other device |
| Syncthing (no cloud) | Save the backup into a Syncthing-shared folder on the phone; it appears on the PC |
| Cloud drive | Share the backup to Google Drive. It is encrypted, so only ciphertext is stored |

Restoring **replaces** the data on the target device. Treat one device as the main one where you enter data.

## CSV formats

```
transactions.csv : date,holding,class,type,amount,units,note
prices.csv       : date,holding,price,value
holdings.csv     : name,class,symbol,mode,unit,notes
```

- **`class`:** `psx`, `mf`, `bank`, `gold` or `other`.
- **`type`:** `BUY`, `SELL`, `INCOME`, `REINVEST` or `FEE`. The aliases `DEPOSIT`, `WITHDRAWAL`, `DIVIDEND`, `PROFIT` and `BONUS` are also accepted.
- **`price` vs `value`:** for units-tracked holdings `price` is the per-unit price. For balance-tracked holdings use `value`.

## Roadmap ideas

- **Automatic daily prices.** A scheduled GitHub Action would scrape PSX closing prices, MUFAP NAVs and the gold rate, then commit a `prices.json` to this repo. The app runs on the same origin, so it can read that file with no CORS issues and your data still never leaves the device.
- Charts of portfolio value over time and per class.
- Benchmarks such as KSE-100, T-bill and inflation, for comparison.

## Files

```
index.html            app shell and dialogs
app.js                UI, storage, import/export, encryption
finance.js            XIRR, CAGR and CSV helpers (pure, tested)
zakat.js              Zakat / nisab calculation (pure, tested)
feed.js               maps data/prices.json to holding prices (pure, tested)
scripts/              price fetcher run by GitHub Actions
data/prices.json      latest public prices (written by the Action)
styles.css            mobile-first styles, light/dark
sw.js                 offline cache
manifest.webmanifest  install metadata
tests/                node unit tests
```

## License

MIT
