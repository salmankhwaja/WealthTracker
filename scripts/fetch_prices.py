#!/usr/bin/env python3
"""Fetch public market prices into data/prices.json for the WealthTracker app.

Runs on GitHub Actions (see .github/workflows/prices.yml). Standard library only.

Sources
  funds   MUFAP daily NAV table (all AMCs)      https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3
  metals  gold-api.com spot XAU / XAG (USD/oz)  https://api.gold-api.com/price/XAU
          fallback: fawazahmed0 currency-api    https://github.com/fawazahmed0/exchange-api
  psx     PSX Data Portal market watch (all shares, one request)  https://dps.psx.com.pk/market-watch
          + share names from https://dps.psx.com.pk/symbols (best effort)
          PSX restricts redistribution of its market data, so PSX prices are fetched ONLY when the
          repo secret PSX_DATA_KEY is set, and are written ONLY as data/psx.enc.json, encrypted with
          AES-256-GCM (key = PBKDF2-SHA256 of that passphrase). The app decrypts it on your device.
  fx      open.er-api.com (USD base)            https://open.er-api.com/v6/latest/USD
          fallback: fawazahmed0 currency-api

If a source fails, the previous value is kept (marked stale) so the app never loses data.
Nothing about the user is sent anywhere: this only downloads public prices.
"""
from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import sys
import base64
import hashlib
import http.cookiejar
import urllib.request
from html.parser import HTMLParser

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "prices.json")
PSX_OUT = os.path.join(os.path.dirname(__file__), "..", "data", "psx.enc.json")
PBKDF2_ITER = 310000
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 WealthTracker-price-bot"
TROY_OZ_G = 31.1034768
TOLA_G = 11.664

MUFAP_URL = "https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3"
MUFAP_URLS = [
    MUFAP_URL,
    "https://mufap.com.pk/Industry/IndustryStatDaily?tab=3",
    "https://beta.mufap.com.pk/Industry/IndustryStatDaily?tab=3",
    "https://mail.mufap.com.pk/Industry/IndustryStatDaily?tab=3",
]
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
}
GOLDAPI = "https://api.gold-api.com/price/{sym}"
ERAPI = "https://open.er-api.com/v6/latest/USD"
CURAPI = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
]
FX_CODES = ["USD", "EUR", "GBP", "AED", "SAR", "CNY"]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def get(url: str, timeout: int = 60, headers: dict | None = None) -> str:
    h = headers or {"User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return raw.decode(r.headers.get_content_charset() or "utf-8", "replace")


def get_json(url: str):
    return json.loads(get(url))


# ---------------------------------------------------------------- MUFAP
class _Tables(HTMLParser):
    """Collects every <table> as a list of rows; each row is a list of (text, colspan)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self._stack = [], []
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._stack.append([])
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            span = dict(attrs).get("colspan") or "1"
            self._cell = [[], int(span) if span.isdigit() else 1]
        elif tag == "br" and self._cell is not None:
            self._cell[0].append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = re.sub(r"\s+", " ", "".join(self._cell[0])).strip()
            self._row.append((text, self._cell[1]))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._stack:
            if self._row:
                self._stack[-1].append(self._row)
            self._row = None
        elif tag == "table" and self._stack:
            self.tables.append(self._stack.pop())

    def handle_data(self, data):
        if self._cell is not None:
            self._cell[0].append(data)


def _num(s: str):
    s = (s or "").replace(",", "").strip()
    try:
        v = float(s)
        return v if v > 0 else None
    except ValueError:
        return None


def _date(s: str):
    s = (s or "").strip()
    for fmt in ("%b %d, %Y", "%d-%b-%Y", "%d %b %Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%B %d, %Y"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


AMC_HINT = re.compile(r"(asset management|investments?|limited|ltd|capital|funds? ltd|modaraba|amc)", re.I)
SECTOR_HINT = re.compile(r"^(open[- ]end|closed[- ]end|voluntary pension|vps|etf|exchange traded|dedicated|fund of funds|conventional|shariah|islamic)\b", re.I)


def parse_mufap(page: str):
    p = _Tables()
    p.feed(page)
    funds, debug = [], []
    for table in p.tables:
        header_idx, cols = None, None
        for i, row in enumerate(table[:8]):
            low = [t.lower() for t, _ in row]
            if any(c == "fund" or c.startswith("fund") for c in low) and any("nav" == c or c.startswith("nav") for c in low):
                header_idx, cols = i, low
                break
        if header_idx is None:
            continue

        def col(*names):
            for n in names:
                for j, c in enumerate(cols):
                    if c == n or c.startswith(n):
                        return j
            return None

        ci = {
            "fund": col("fund name", "fund"), "amc": col("amc", "asset management"), "category": col("category"),
            "offer": col("offer"), "repurchase": col("repurchase", "redemption"), "nav": col("nav"),
            "date": col("validity", "nav date", "date"), "sector": col("sector"),
        }
        amc_ctx, sector_ctx = "", ""
        for row in table[header_idx + 1:]:
            texts = [t for t, _ in row]
            if len(row) == 1 or (len(row) <= 2 and row[0][1] > 2):     # group heading row
                t = texts[0]
                if SECTOR_HINT.search(t) and not AMC_HINT.search(t):
                    sector_ctx = t
                else:
                    amc_ctx = t
                continue
            if len(texts) < len(cols) - 1 or ci["fund"] is None or ci["nav"] is None:
                continue
            g = lambda k: texts[ci[k]] if ci[k] is not None and ci[k] < len(texts) else ""
            nav = _num(g("nav"))
            name = html.unescape(g("fund")).strip()
            if not name or nav is None:
                continue
            funds.append({
                "fund": name,
                "amc": g("amc") or amc_ctx or "",
                "sector": g("sector") or sector_ctx or "",
                "category": g("category"),
                "nav": nav,
                "offer": _num(g("offer")),
                "repurchase": _num(g("repurchase")),
                "date": _date(g("date")) or g("date"),
            })
        if not funds:
            debug.append({"header": cols, "sample": [[t for t, _ in r] for r in table[header_idx + 1: header_idx + 6]]})
    if not funds:
        debug.append({"tables": len(p.tables), "first_rows": [[[t for t, _ in r] for r in tb[:3]] for tb in p.tables[:4]]})
    # de-duplicate by fund name, keep newest date
    best = {}
    for f in funds:
        k = f["fund"].lower()
        if k not in best or str(f["date"]) > str(best[k]["date"]):
            best[k] = f
    return sorted(best.values(), key=lambda f: (f["amc"].lower(), f["fund"].lower())), debug


def fetch_funds(errors):
    tried = []
    for url in MUFAP_URLS:
        for hdrs in (BROWSER_HEADERS, None):
            try:
                page = get(url, timeout=90, headers=hdrs)
            except Exception as e:  # noqa: BLE001
                tried.append({"url": url, "browser": hdrs is not None, "error": repr(e)[:160]})
                continue
            items, debug = parse_mufap(page)
            if items:
                dates = sorted({f["date"] for f in items if f["date"]})
                return {"source": "MUFAP", "url": url, "fetched": now_iso(), "latest_date": dates[-1] if dates else None,
                        "count": len(items), "items": items}
            tried.append({"url": url, "browser": hdrs is not None, "error": "no funds parsed", "bytes": len(page),
                          "head": re.sub(r"\s+", " ", page[:400]), "debug": debug})
    errors.append({"source": "mufap", "error": "all attempts failed", "attempts": tried})
    return None



# ---------------------------------------------------------------- PSX (parser adapted from Day-Trader-PSX)
PSX_HOST = "https://dps.psx.com.pk"
_CELL = re.compile(r"<t([hd])([^>]*)>(.*?)</t[hd]>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")
_PSX_FIELDS = {"symbol": "symbol", "sector": "sector", "listed in": "listed_in", "ldcp": "ldcp", "open": "open",
               "high": "high", "low": "low", "current": "current", "change": "change", "change (%)": "change_pct",
               "volume": "volume"}
_PSX_ORDER = ["symbol", "sector", "listed_in", "ldcp", "open", "high", "low", "current", "change", "change_pct", "volume"]


def _pnum(v):
    v = (v or "").replace(",", "").replace("%", "").strip()
    neg = v.startswith("(") and v.endswith(")")
    try:
        x = float(v.strip("()"))
    except ValueError:
        return None
    return -x if neg else x


def parse_market_watch(text):
    """{SYMBOL: {sector, ldcp, open, high, low, current, change, change_pct, volume}} from PSX's market-watch table."""
    order, quotes = None, {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I):
        cells = _CELL.findall(tr)
        if not cells:
            continue
        if all(k.lower() == "h" for k, _, _ in cells):
            names = [html.unescape(_TAG.sub("", c)).strip().lower() for _, _, c in cells]
            order = [_PSX_FIELDS.get(n, n) for n in names]
            continue
        row = {}
        for (kind, attrs, body), name in zip(cells, order or _PSX_ORDER):
            m = re.search(r'data-search="([^"]+)"', attrs)
            txt = html.unescape(_TAG.sub("", body)).strip()
            if name == "symbol":
                val = m.group(1) if m else txt
                row["symbol"] = val.split()[0].upper() if val.strip() else None
            elif name in ("sector", "listed_in"):
                row[name] = txt
            else:
                o = re.search(r'data-order="([^"]+)"', attrs)
                row[name] = _pnum(o.group(1) if o else txt)
        if row.get("symbol") and row.get("current"):
            if row.get("change_pct") is None and row.get("ldcp"):
                row["change_pct"] = round(100 * (row["current"] / row["ldcp"] - 1), 2)
            quotes[row.pop("symbol")] = row
    return quotes


def pk_session_date(now=None):
    """Latest PSX weekday session date in Pakistan time (holidays aside)."""
    d = ((now or dt.datetime.now(dt.timezone.utc)) + dt.timedelta(hours=5)).date()
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


_KEY_RE = re.compile(r'window\.__ps\s*=\s*\{[^}]*?"_k"\s*:\s*"([^"]+)"')


class PsxSession:
    """PSX's portal answers data URLs only with its session cookie and the page key (window.__ps._k)
    sent back as X-Req-Id -- the same approach Day-Trader-PSX uses."""

    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.key = None

    def _open(self, url, headers, timeout=60):
        h = dict(BROWSER_HEADERS); h["Accept-Encoding"] = "gzip"; h.update(headers or {})
        with self.opener.open(urllib.request.Request(url, headers=h), timeout=timeout) as r:
            raw = r.read()
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                import gzip
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", "replace")

    def refresh_key(self):
        for path in ("/", "/company/OGDC"):
            m = _KEY_RE.search(self._open(PSX_HOST + path, {"Accept": "text/html"}))
            if m:
                self.key = m.group(1)
                return self.key
        return None

    def get(self, path):
        for attempt in (0, 1):
            if attempt or not self.key:
                self.refresh_key()
            hdr = {"X-Requested-With": "XMLHttpRequest", "Referer": PSX_HOST + "/",
                   "Accept": "application/json, text/javascript, text/html, */*; q=0.01"}
            if self.key:
                hdr["X-Req-Id"] = self.key
            try:
                return self._open(PSX_HOST + path, hdr)
            except urllib.error.HTTPError as e:
                if attempt or e.code not in (401, 403, 404, 419):
                    raise


def fetch_psx(errors):
    sess = PsxSession()
    try:
        quotes = parse_market_watch(sess.get("/market-watch"))
        if len(quotes) < 20:
            raise ValueError(f"only {len(quotes)} quotes parsed")
    except Exception as e:  # noqa: BLE001
        errors.append({"source": "psx market-watch", "error": repr(e)[:300]})
        return None
    names = {}
    try:
        for x in json.loads(sess.get("/symbols")):
            if isinstance(x, dict) and x.get("symbol"):
                names[str(x["symbol"]).upper()] = x.get("name") or ""
    except Exception as e:  # noqa: BLE001
        errors.append({"source": "psx symbols (names only)", "error": repr(e)[:160]})
    items = {}
    for sym, q in quotes.items():
        items[sym] = {k: q.get(k) for k in ("current", "ldcp", "change_pct", "volume", "sector") if q.get(k) is not None}
        if names.get(sym):
            items[sym]["name"] = names[sym]
    return {"source": "PSX Data Portal market watch", "url": PSX_HOST + "/market-watch", "fetched": now_iso(),
            "date": pk_session_date(), "count": len(items), "items": items}


def encrypt_json(obj, passphrase: str) -> dict:
    """AES-256-GCM, key from PBKDF2-SHA256 — the same format the app's backups use, decrypted with WebCrypto."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, PBKDF2_ITER, 32)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, separators=(",", ":")).encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"format": "pk-wealth-psx", "v": 1, "enc": "AES-256-GCM/PBKDF2-SHA256", "iterations": PBKDF2_ITER,
            "salt": b(salt), "iv": b(iv), "data": b(ct), "updated": now_iso()}


def decrypt_json(doc: dict, passphrase: str):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), base64.b64decode(doc["salt"]), doc["iterations"], 32)
    return json.loads(AESGCM(key).decrypt(base64.b64decode(doc["iv"]), base64.b64decode(doc["data"]), None))


# ---------------------------------------------------------------- metals & FX
def fetch_metals(errors):
    out = {}
    for key, sym in (("gold", "XAU"), ("silver", "XAG")):
        try:
            j = get_json(GOLDAPI.format(sym=sym))
            price = float(j["price"])
            out[key] = {"usd_oz": price, "time": j.get("updatedAt") or now_iso(), "source": "gold-api.com"}
        except Exception as e:  # noqa: BLE001
            errors.append({"source": f"gold-api {sym}", "error": repr(e)[:200]})
    return out


def fetch_curapi(errors):
    for url in CURAPI:
        try:
            j = get_json(url)
            return j
        except Exception as e:  # noqa: BLE001
            errors.append({"source": "currency-api", "error": repr(e)[:200]})
    return None


def fetch_fx(errors):
    try:
        j = get_json(ERAPI)
        if j.get("result") != "success":
            raise ValueError(j.get("error-type", "bad response"))
        rates = j["rates"]
        pkr = float(rates["PKR"])
        return {
            "source": "open.er-api.com (ExchangeRate-API)", "time": j.get("time_last_update_utc") or now_iso(),
            "pkr": {c: round(pkr / float(rates[c]), 4) for c in FX_CODES if c in rates},
        }
    except Exception as e:  # noqa: BLE001
        errors.append({"source": "open.er-api", "error": repr(e)[:200]})
        return None


def build(prev: dict) -> dict:
    errors = []
    funds = fetch_funds(errors)
    metals = fetch_metals(errors)
    fx = fetch_fx(errors)

    cur = None
    if fx is None or "gold" not in metals or "silver" not in metals:
        cur = fetch_curapi(errors)
    if cur:
        usd = cur.get("usd", {})
        if fx is None and usd.get("pkr"):
            fx = {"source": "currency-api (fawazahmed0)", "time": cur.get("date"),
                  "pkr": {c: round(float(usd["pkr"]) / float(usd[c.lower()]), 4) for c in FX_CODES if usd.get(c.lower())}}
        for key, code in (("gold", "xau"), ("silver", "xag")):
            if key not in metals and usd.get(code):
                metals[key] = {"usd_oz": round(1 / float(usd[code]), 4), "time": cur.get("date"), "source": "currency-api (fawazahmed0)"}

    out = {"version": 1, "updated": now_iso(), "errors": errors}
    stale = []

    # FX
    if fx:
        out["fx"] = fx
    elif prev.get("fx"):
        out["fx"] = {**prev["fx"], "stale": True}; stale.append("fx")

    # Metals in PKR
    usdpkr = (out.get("fx") or {}).get("pkr", {}).get("USD")
    out["metals"] = {}
    for key in ("gold", "silver"):
        m = metals.get(key)
        if m and usdpkr:
            per_g = m["usd_oz"] * usdpkr / TROY_OZ_G
            out["metals"][key] = {**m, "usdpkr": usdpkr, "pkr_gram": round(per_g, 2), "pkr_tola": round(per_g * TOLA_G, 2),
                                  "note": "International spot, 24K, converted at the open-market USD/PKR rate; local Sarafa rates usually include a premium."}
        elif (prev.get("metals") or {}).get(key):
            out["metals"][key] = {**prev["metals"][key], "stale": True}; stale.append(key)

    # Funds
    if funds:
        out["funds"] = funds
    elif prev.get("funds"):
        out["funds"] = {**prev["funds"], "stale": True}; stale.append("funds")

    out["stale"] = stale
    return out


# Fields that change on every run even when no price did. Ignored when deciding whether to
# write (and so commit) a new file: a quiet run then costs no commit and no Pages rebuild.
VOLATILE = {"updated", "fetched", "time", "errors"}


def same_prices(a, b) -> bool:
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in VOLATILE}
        if isinstance(o, list):
            return [strip(x) for x in o]
        return o
    return strip(a) == strip(b)


def main() -> int:
    try:
        with open(OUT, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, ValueError):
        prev = {}
    data = build(prev)
    data.pop("psx", None)  # never publish PSX data in the clear
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    key = os.environ.get("PSX_DATA_KEY", "").strip()
    if key:
        psx_errors = []
        psx = fetch_psx(psx_errors)
        if psx:
            old = None
            try:
                with open(PSX_OUT, encoding="utf-8") as f:
                    old = decrypt_json(json.load(f), key)
            except Exception:  # noqa: BLE001 -- no file yet, or a new passphrase
                pass
            if old is None or not same_prices(old, psx):   # re-encrypting always differs (new salt), so only when needed
                with open(PSX_OUT, "w", encoding="utf-8") as f:
                    json.dump(encrypt_json(psx, key), f, separators=(",", ":"))
            data["psx_private"] = {"available": True, "count": psx["count"], "date": psx["date"]}
        else:
            data["psx_private"] = {"available": os.path.exists(PSX_OUT), "stale": True}
        data["errors"] += psx_errors
    else:
        data["psx_private"] = {"available": False, "note": "Set the PSX_DATA_KEY repo secret to enable encrypted PSX prices."}
    if prev and same_prices(prev, data):
        print("no price changed since the last run: file left as it is (no commit)")
    else:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    f_ = data.get("funds") or {}
    print(f"funds={f_.get('count')} date={f_.get('latest_date')} usd={((data.get('fx') or {}).get('pkr') or {}).get('USD')} "
          f"psx={data.get('psx_private')} gold_tola={(data['metals'].get('gold') or {}).get('pkr_tola')} errors={len(data['errors'])} stale={data['stale']}")
    for e in data["errors"]:
        print("ERROR", json.dumps(e)[:600], file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
