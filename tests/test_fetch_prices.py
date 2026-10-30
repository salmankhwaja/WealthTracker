"""Run: python3 tests/test_fetch_prices.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import fetch_prices as fp

page = open(os.path.join(os.path.dirname(__file__), "fixtures", "mufap_sample.html")).read()
items, debug = fp.parse_mufap(page)
names = [i["fund"] for i in items]
assert names == ["ABL Cash Fund", "Meezan Islamic Fund", "NBP Islamic Stock Fund & Co"], names
mif = items[1]
assert mif["amc"] == "Al Meezan Investment Management Limited", mif
assert mif["nav"] == 95.2 and mif["date"] == "2026-10-29", mif   # newest row kept
assert mif["sector"] == "Open End Schemes"
assert items[2]["nav"] == 1210.5 and items[2]["offer"] == 1234.56

# Layout with an AMC column instead of group rows
page2 = """<table><tr><th>Sector</th><th>AMC</th><th>Fund</th><th>Category</th><th>Offer</th><th>Repurchase</th><th>NAV</th><th>Validity Date</th></tr>
<tr><td>Open End</td><td>NBP Fund Management</td><td>NBP Money Market Fund</td><td>Money Market</td><td>10.1</td><td>10.1</td><td>10.1</td><td>29-Oct-2026</td></tr></table>"""
it2, _ = fp.parse_mufap(page2)
assert it2[0]["amc"] == "NBP Fund Management" and it2[0]["date"] == "2026-10-29", it2

# PSX market watch (format as parsed by Day-Trader-PSX)
mw = """<table><thead><tr><th>SYMBOL</th><th>SECTOR</th><th>LISTED IN</th><th>LDCP</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CURRENT</th><th>CHANGE</th><th>CHANGE (%)</th><th>VOLUME</th></tr></thead>
<tbody><tr><td data-search="OGDC Oil &amp; Gas Development"><a>OGDC</a></td><td>OIL &amp; GAS</td><td>KSE100</td><td>250.10</td><td>251</td><td>255</td><td>249</td><td data-order="253.5">253.50</td><td>3.40</td><td>1.36%</td><td>1,234,567</td></tr>
<tr><td>LUCK</td><td>CEMENT</td><td>KSE100</td><td>1,000.00</td><td>990</td><td>1,001</td><td>980</td><td>985.00</td><td>(15.00)</td><td></td><td>10,000</td></tr></tbody></table>"""
q = fp.parse_market_watch(mw)
assert q["OGDC"]["current"] == 253.5 and q["OGDC"]["volume"] == 1234567 and q["OGDC"]["sector"] == "OIL & GAS", q
assert q["LUCK"]["change"] == -15 and q["LUCK"]["change_pct"] == -1.5, q

# Stale carry-over when every source fails
fp.get = lambda *a, **k: (_ for _ in ()).throw(OSError("offline"))
prev = {"fx": {"pkr": {"USD": 280.0}}, "metals": {"gold": {"pkr_tola": 1}}, "funds": {"count": 3, "items": items}, "psx": {"count": 2, "items": q}}
out = fp.build(prev)
assert out["fx"]["stale"] and out["funds"]["stale"] and out["metals"]["gold"]["stale"], out
assert set(out["stale"]) == {"fx", "gold", "funds", "psx"}, out["stale"]
print("All fetch_prices tests passed.")
