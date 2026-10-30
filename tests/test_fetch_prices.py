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

# Stale carry-over when every source fails
fp.get = lambda *a, **k: (_ for _ in ()).throw(OSError("offline"))
prev = {"fx": {"pkr": {"USD": 280.0}}, "metals": {"gold": {"pkr_tola": 1}}, "funds": {"count": 3, "items": items}}
out = fp.build(prev)
assert out["fx"]["stale"] and out["funds"]["stale"] and out["metals"]["gold"]["stale"], out
assert set(out["stale"]) == {"fx", "gold", "funds"}
print("All fetch_prices tests passed.")
