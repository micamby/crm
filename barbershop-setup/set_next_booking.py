"""One-off: fill each sample client's Next booking from their booked appointments."""
import json, re, urllib.request, urllib.error
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
appts = call("POST", "/v1/query", {"object": "appointment", "where": {"field": "status", "op": "eq", "value": "booked"}, "limit": 200})["data"]
nxt = {}
for a in appts:
    c = a["client"] if isinstance(a["client"], str) else a["client"]["id"]
    nxt[c] = min(nxt.get(c, a["starts_at"]), a["starts_at"])
for c, t in nxt.items():
    call("PATCH", f"/v1/objects/contact/records/{c}", {"next_booked_at": t, "overdue": False})
print(f"Set Next booking on {len(nxt)} sample clients.")
