"""Create the shop's starting services with their lengths (edit them any time in the app under Services),
and link existing appointments to them. Safe to run again."""
import json, re, urllib.request, urllib.error
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
START = [("haircut", "Haircut", 30), ("skin_fade", "Skin fade", 45), ("cut_and_beard", "Cut and beard", 60),
         ("beard_trim", "Beard trim", 20), ("lineup", "Line-up", 15), ("kids_cut", "Kids cut", 30)]
have = {s["name"]: s for s in call("POST", "/v1/query", {"object": "service", "limit": 200})["data"]}
by_key = {}
for key, name, mins in START:
    if name not in have:
        have[name] = call("POST", "/v1/objects/service/records", {"name": name, "length_minutes": mins})["data"]
    by_key[key] = have[name]
rows, cur = [], None
while True:
    d = call("POST", "/v1/query", {"object": "appointment", "where": {"field": "service_type", "op": "is_null", "value": True}, "limit": 200, **({"cursor": cur} if cur else {})})
    rows += d["data"]; cur = d.get("next_cursor")
    if not cur: break
for a in rows:
    s = by_key.get(a.get("service"))
    if s:
        call("PATCH", f"/v1/objects/appointment/records/{a['id']}", {"service_type": s["id"], "length_minutes": s["length_minutes"]})
print(f"{len(have)} services; linked {len(rows)} appointments.")
