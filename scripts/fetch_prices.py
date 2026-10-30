#!/usr/bin/env python3
"""Fetch public market prices into data/prices.json for the WealthTracker app.

Runs on GitHub Actions (see .github/workflows/prices.yml). Standard library only.

Sources
  funds   MUFAP daily NAV table (all AMCs)      https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3
  metals  gold-api.com spot XAU / XAG (USD/oz)  https://api.gold-api.com/price/XAU
          fallback: fawazahmed0 currency-api    https://github.com/fawazahmed0/exchange-api
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
import urllib.request
from html.parser import HTMLParser

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "prices.json")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 WealthTracker-price-bot"
TROY_OZ_G = 31.1034768
TOLA_G = 11.664

MUFAP_URL = "https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=3"
GOLDAPI = "https://api.gold-api.com/price/{sym}"
ERAPI = "https://open.er-api.com/v6/latest/USD"
CURAPI = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
]
FX_CODES = ["USD", "EUR", "GBP", "AED", "SAR", "CNY"]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def get(url: str, timeout: int = 60) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")


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
    try:
        page = get(MUFAP_URL, timeout=90)
        items, debug = parse_mufap(page)
        if not items:
            errors.append({"source": "mufap", "error": "no funds parsed", "debug": debug, "bytes": len(page)})
            return None
        dates = sorted({f["date"] for f in items if f["date"]})
        return {"source": "MUFAP", "url": MUFAP_URL, "fetched": now_iso(), "latest_date": dates[-1] if dates else None,
                "count": len(items), "items": items}
    except Exception as e:  # noqa: BLE001
        errors.append({"source": "mufap", "error": repr(e)[:300]})
        return None


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


def main() -> int:
    try:
        with open(OUT, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, ValueError):
        prev = {}
    data = build(prev)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    f_ = data.get("funds") or {}
    print(f"funds={f_.get('count')} date={f_.get('latest_date')} usd={((data.get('fx') or {}).get('pkr') or {}).get('USD')} "
          f"gold_tola={(data['metals'].get('gold') or {}).get('pkr_tola')} errors={len(data['errors'])} stale={data['stale']}")
    for e in data["errors"]:
        print("ERROR", json.dumps(e)[:600], file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
