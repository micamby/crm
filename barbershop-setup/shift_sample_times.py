"""One-off: the first sample appointments were written in UTC shop hours (9-18 UTC = 3 AM-noon in Chicago).
Move them 6 hours later so they fall in normal shop hours. Leaves the live test appointments alone."""
import json, re, urllib.request, urllib.error, datetime as dt
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
skip = set((Path(__file__).parent / ".test_ids").read_text().split())
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
rows, cur = [], None
while True:
    d = call("POST", "/v1/query", {"object": "appointment", "limit": 200, **({"cursor": cur} if cur else {})})
    rows += d["data"]; cur = d.get("next_cursor")
    if not cur: break
n = 0
for a in rows:
    if a["id"] in skip: continue
    t = dt.datetime.fromisoformat(a["starts_at"].replace("Z", "+00:00")) + dt.timedelta(hours=6)
    call("PATCH", f"/v1/objects/appointment/records/{a['id']}", {"starts_at": t.isoformat().replace("+00:00", "Z")})
    n += 1
print(f"Moved {n} sample appointments into shop hours.")
