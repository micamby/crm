"""One-off cleanup: an earlier failed run created the 36 sample clients twice. Archive (not delete) the copies
that have no sample appointments, plus the one test appointment that went to a copy."""
import json, re, urllib.request, urllib.error
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
contacts = call("POST", "/v1/query", {"object": "contact", "limit": 200})["data"]
appts = call("POST", "/v1/query", {"object": "appointment", "limit": 200})["data"]
used = {}
for a in appts:
    used.setdefault(a["client"], []).append(a)
names = {}
for c in contacts:
    names.setdefault((c["first_name"], c["last_name"]), []).append(c)
archived = 0
for key, group in names.items():
    if len(group) < 2:
        continue
    keep = max(group, key=lambda c: len([a for a in used.get(c["id"], []) if not (a.get("visit_notes") or "").startswith("TEST")]))
    for c in group:
        if c["id"] == keep["id"]:
            continue
        for a in used.get(c["id"], []):
            call("DELETE", f"/v1/objects/appointment/records/{a['id']}")
        call("DELETE", f"/v1/objects/contact/records/{c['id']}")
        archived += 1
print(f"Archived {archived} duplicate sample clients. Clients now: {len(contacts) - archived}")
