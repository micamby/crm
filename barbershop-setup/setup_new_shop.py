"""Set up a new barbershop workspace the MICROSPACE way, in one go.

Run it once, right after the CRM's Quick start `bootstrap` step has created the shop's workspace and printed its two keys
(saved in ~/Desktop/CRM-SECRET-KEYS.txt, or pass --keys <file>). It installs the barbershop pack, renames Contacts to
Clients, hides what barbershops don't use, and creates the automatic jobs, reminders, starting services, message wording
and the owner's Barber record. Safe to run again: anything that already exists is left as it is.

    python3 setup_new_shop.py --timezone America/Toronto
"""
import argparse, json, re, subprocess, sys, tempfile, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
ap = argparse.ArgumentParser()
ap.add_argument("--keys", default=str(Path.home() / "Desktop/CRM-SECRET-KEYS.txt"))
ap.add_argument("--url", default="http://localhost:8787")
ap.add_argument("--timezone", default="America/Chicago", help="The shop's time zone, e.g. America/Chicago, America/Toronto, Europe/London")
args = ap.parse_args()
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", Path(args.keys).read_text()).group(1)


def call(m, p, b=None):
    r = urllib.request.Request(args.url + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")


def crm(*a, stdin=None):
    out = subprocess.run(["node", str(REPO / "packages/cli/dist/main.js"), *a], input=stdin, text=True, capture_output=True)
    if out.returncode not in (0, 5):
        raise SystemExit(f"crm {' '.join(a)} failed:\n{out.stdout}{out.stderr}")
    return out.stdout


def step(msg): print(f"- {msg}", flush=True)


owner_id = call("GET", "/v1/me")["actor"]["id"]
owner = next(u for u in call("GET", "/v1/users")["data"] if u["id"] == owner_id)
step(f"Workspace owner: {owner['name']}")

crm("auth", "login", "--url", args.url, "--with-token", "--name", "shop", stdin=KEY + "\n")
crm("pack", "install", str(REPO / "packs/barbershop"), "--yes")
step("Barbershop pack installed (clients, barbers, services, appointments, lists, Barber role)")

for f in ("relabel.yaml", "tidy-menu.yaml"):
    doc = re.sub(r"(?m)^schema_version:.*\n", "", (HERE / f).read_text())
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as t:
        t.write(doc)
    crm("schema", "apply", "-f", t.name, "--yes", "--accept-drift")
step("Contacts renamed to Clients; Leads, Deals and Accounts hidden")

have = {a["name"] for a in call("GET", "/v1/automations")["data"]}
for f in sorted((HERE / "automations").glob("*.yaml")):
    text = f.read_text().replace("OWNER_USER_ID", owner_id).replace("SHOP_TIMEZONE", args.timezone)
    name = re.search(r"(?m)^name:\s*(.+)$", text).group(1).strip()
    if name in have:
        continue
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as t:
        t.write(text)
    crm("automations", "create", "--file", t.name, "--yes")
step("Automatic jobs ready")

have = {a["name"] for a in call("GET", "/v1/alerts")["data"]}
for a in json.loads((HERE / "alerts.json").read_text().replace("OWNER_USER_ID", owner_id)):
    if a["name"] not in have:
        call("POST", "/v1/alerts", {k: v for k, v in a.items() if v is not None})
step("Reminders ready (they go to each client's barber and to the owner)")

for script in ("setup_services.py", "setup_messages.py"):
    subprocess.run([sys.executable, "-I", str(HERE / script)], check=True, capture_output=True)
step("Starting services (with lengths) and message wording ready")

barbers = {b.get("member_email") for b in call("POST", "/v1/query", {"object": "barber", "limit": 200})["data"]}
if owner["email"] not in barbers:
    call("POST", "/v1/objects/barber/records", {"name": owner["name"], "member_email": owner["email"], "home_chair": "chair_1"})
subprocess.run([sys.executable, "-I", str(HERE / "make_barber_views.py")], check=True, capture_output=True)
step("Owner added as a barber, with their own lists")
print("\nDone. Next: add the shop's barbers (see NEW-SHOP.md), then check Services, Messages and the cancellation policy in the app.")
