"""Create shared lists for each barber: their clients, their call-back list and their upcoming appointments.
Barbers are matched by sign-in email (Barber.member_email = member email). Safe to run again: existing names are skipped."""
import json, re, urllib.request, urllib.error
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
users = {u["email"]: u for u in call("GET", "/v1/users")["data"]}
barbers = call("POST", "/v1/query", {"object": "barber", "limit": 200})["data"]
have = {v["name"] for o in ("contact", "appointment") for v in call("GET", f"/v1/objects/{o}/views")["data"]}
made = 0
for b in barbers:
    u = users.get(b.get("member_email"))
    if not u:
        continue
    first = b["name"].split(" ")[0]
    lists = [
        ("contact", f"{first}'s clients", {"field": "owner", "op": "eq", "value": u["id"]}, [{"field": "last_name"}],
         ["first_name", "last_name", "phone", "return_every", "last_visit_at", "next_visit_due", "regular"]),
        ("contact", f"{first}'s call-back list", {"and": [{"field": "owner", "op": "eq", "value": u["id"]}, {"field": "overdue", "op": "eq", "value": True}]},
         [{"field": "next_visit_due"}], ["first_name", "last_name", "phone", "next_visit_due", "reminder_text"]),
        ("appointment", f"{first}'s upcoming appointments", {"and": [{"field": "barber", "op": "eq", "value": b["id"]}, {"field": "status", "op": "eq", "value": "booked"}]},
         [{"field": "starts_at"}], ["starts_at", "client", "service", "chair"]),
    ]
    for obj, name, where, sort, cols in lists:
        if name in have:
            continue
        call("POST", "/v1/views", {"object": obj, "name": name, "shared": True, "where": where, "sort": sort, "columns": cols})
        made += 1
print(f"Created {made} barber lists.")
