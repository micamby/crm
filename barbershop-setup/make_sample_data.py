"""Create made-up sample clients and appointments for testing the barbershop setup.

Every name and phone number here is invented (phones use the 555-01xx range reserved for fiction).
Usage: python3 make_sample_data.py   (reads the admin key from ~/Desktop/CRM-SECRET-KEYS.txt)
"""
import json, random, re, urllib.request, urllib.error, datetime as dt
from pathlib import Path

API = "http://localhost:8787"
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
random.seed(42)


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} failed: {e.code} {e.read().decode()[:800]}")


users = call("GET", "/v1/users")["data"]
barbers = [u["id"] for u in users]  # Michael plus the sample barbers
chairs = ["chair_1", "chair_2", "chair_3", "chair_4", "chair_5"]
chair_of = {b: chairs[i % 5] for i, b in enumerate(barbers)}
rebook_skill = {b: r for b, r in zip(barbers, [0.8, 0.7, 0.55, 0.65, 0.45])}

first = ["Jay", "Andre", "Kevin", "Marco", "Darius", "Sam", "Eli", "Omar", "Tyler", "Chris", "Jordan", "Malik", "Ben", "Nate",
         "Isaiah", "Luca", "Devon", "Rafael", "Owen", "Xavier", "Caleb", "Miles", "Theo", "Jalen", "Victor", "Ryan", "Hector",
         "Zane", "Aaron", "Dante", "Felix", "Grant", "Kai", "Leo", "Mason", "Noah"]
last = ["Ruiz", "Brooks", "Nguyen", "Bennett", "Coleman", "Patel", "Foster", "Haddad", "Reyes", "Kim", "Price", "Okafor",
        "Sullivan", "Ward", "Ortiz", "Romano", "Hayes", "Silva", "Grant", "Morales", "Fisher", "Dixon", "Lam", "Carter",
        "Ibarra", "Shaw", "Vega", "Ellis", "Moreno", "Pierce", "Quinn", "Tate", "Young", "Lopez", "Baker", "Hill"]
chats = ["New job downtown, starts Monday", "Trip to Cancun in March", "Daughter just started kindergarten",
         "Training for a half marathon", "Bought a new truck", "Big game this weekend", "Wedding coming up in June",
         "Moving apartments next month", "Learning to cook Thai food", "Fantasy football league is going badly",
         "Just got a puppy", "Brother visiting from Chicago", "Thinking about growing a beard", "Graduated last week"]
usual = {"haircut": "Scissor cut, taper on the sides", "skin_fade": "Skin fade, #2 on top", "cut_and_beard": "Low fade plus beard shape-up",
         "lineup": "Line-up and edge", "kids_cut": "Kids cut, short on the sides", "beard_trim": "Beard trim, keep the length"}
weeks_opts = {"w2": 2, "w3": 3, "w4": 4, "w5": 5, "w6": 6}

now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
today = now.date()

clients, appts = [], []
for i in range(36):
    barber = barbers[i % len(barbers)]
    service = random.choice(list(usual))
    every = random.choice(list(weeks_opts))
    clients.append({"first_name": first[i], "last_name": last[i], "phone": f"+1312555{100 + i:04d}",
                    "owner": barber, "return_every": every, "usual_cut": usual[service], "_service": service, "_weeks": weeks_opts[every]})

# Visits over the last ten weeks, then an upcoming booking for the clients who rebooked.
for c in clients:
    t = now - dt.timedelta(days=random.randint(60, 75))
    visits = []
    while True:
        gap = c["_weeks"] * 7 + random.randint(-3, 10 if random.random() < 0.3 else 4)
        t = t + dt.timedelta(days=gap)
        if t > now + dt.timedelta(days=14):
            break
        visits.append(t.replace(hour=random.randint(15, 23))  # 9 AM-5 PM in Chicago)
    lost = random.random() < 0.2  # some clients drift away: their last visits stop early
    if lost and len(visits) > 1:
        visits = visits[:-1] if visits[-1] > now else visits[:-2] or visits[:1]
    for v in visits:
        future = v > now
        if future:
            status = "booked"
        elif random.random() < 0.06:
            status = "no_show"
        elif random.random() < 0.04:
            status = "cancelled"
        else:
            status = "completed"
        appts.append({"_client": c, "owner": c["owner"], "starts_at": v.isoformat().replace("+00:00", "Z"),
                      "service": c["_service"], "chair": chair_of[c["owner"]], "status": status,
                      "booked_via": "square" if random.random() < 0.25 else "in_shop",
                      "visit_notes": random.choice(chats) if status == "completed" else None})

# Rebooked: a completed visit counts when the client has a later visit and their barber asked (barber-dependent rate).
by_client = {}
for a in appts:
    by_client.setdefault(id(a["_client"]), []).append(a)
for lst in by_client.values():
    lst.sort(key=lambda a: a["starts_at"])
    for j, a in enumerate(lst):
        has_next = j + 1 < len(lst)
        a["rebooked"] = a["status"] == "completed" and has_next and random.random() < rebook_skill[a["owner"]]

# Client summary fields, the way the automations keep them.
for c in clients:
    lst = by_client.get(id(c), [])
    done = [a for a in lst if a["status"] == "completed"]
    upcoming = [a for a in lst if a["status"] == "booked"]
    if done:
        last_v = dt.datetime.fromisoformat(done[-1]["starts_at"].replace("Z", "+00:00"))
        due = (last_v + dt.timedelta(weeks=c["_weeks"])).date()
        c.update(last_visit_at=done[-1]["starts_at"], next_visit_due=due.isoformat(), visit_count=len(done),
                 regular=len(done) >= 3, last_chat=done[-1]["visit_notes"], overdue=due < today and not upcoming)
    c["reminder_text"] = (f"Hey {c['first_name']}, it's been a while since your last cut. "
                          f"Want me to get you booked in this week? - MICROSPACE")

# Create clients, then appointments.
existing = {(r.get("first_name"), r.get("last_name")): r["id"] for r in call("GET", "/v1/objects/contact/records?limit=200")["data"]}
payload = [{k: v for k, v in c.items() if not k.startswith("_") and v is not None} for c in clients if (c["first_name"], c["last_name"]) not in existing]
made = call("POST", "/v1/objects/contact/records/batch", {"records": payload})["data"] if payload else []
for rec in made:
    existing[(rec["first_name"], rec["last_name"])] = rec["id"]
for c in clients:
    c["_id"] = existing[(c["first_name"], c["last_name"])]
# One Barber record per member, linked by sign-in email.
have = {r.get("member_email"): r["id"] for r in call("GET", "/v1/objects/barber/records?limit=200")["data"]}
barber_rec = {}
for u in users:
    if u["email"] not in have:
        have[u["email"]] = call("POST", "/v1/objects/barber/records", {"name": u["name"], "member_email": u["email"], "home_chair": chair_of[u["id"]]})["data"]["id"]
    barber_rec[u["id"]] = have[u["email"]]
rows = []
for a in appts:
    c = a["_client"]
    r = {k: v for k, v in a.items() if not k.startswith("_") and v is not None}
    r["client"] = c["_id"]
    r["barber"] = barber_rec[a["owner"]]
    r.pop("owner", None)
    r["summary"] = f"{c['first_name']} {c['last_name']} - {dict(haircut='Haircut', skin_fade='Skin fade', cut_and_beard='Cut and beard', beard_trim='Beard trim', lineup='Line-up', kids_cut='Kids cut')[a['service']]}"
    rows.append(r)
count = 0
for k in range(0, len(rows), 100):
    count += len(call("POST", "/v1/objects/appointment/records/batch", {"records": rows[k:k + 100]})["data"])
print(f"Created {len(made)} new sample clients ({len(clients)} in all), {len(barber_rec)} barbers and {count} sample appointments.")
