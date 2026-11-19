"""Create the starting message wording (edit it any time in the app under Messages). Safe to run again: existing ones are kept."""
import json, re, urllib.request, urllib.error
from pathlib import Path
KEY = re.search(r"Admin key[^:]*:\s*(hlcrm_\w+)", (Path.home() / "Desktop/CRM-SECRET-KEYS.txt").read_text()).group(1)
def call(m, p, b=None):
    r = urllib.request.Request("http://localhost:8787" + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as x: return json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e: raise SystemExit(f"{m} {p}: {e.code} {e.read().decode()[:500]}")
START = {
    "Time for a cut": "Hi {first_name}, it's {barber} from {shop}. It's been a little while since your last cut, so I wanted to check in. "
                      "Would you like me to save you a spot this week? Just reply with a day and time that works for you. Hope all is well!",
    "Missed appointment": "Hi {first_name}, it's {barber} from {shop}. We missed you at your appointment {when}. I hope everything is okay! "
                          "Whenever you're ready, just reply and we'll find a new time that suits you. {policy}",
    "Cancellation policy": "As a friendly reminder, here is our appointment policy: (paste the shop's own policy here)",
}
have = {t["name"] for t in call("POST", "/v1/query", {"object": "message_template", "limit": 50})["data"]}
for name, text in START.items():
    if name not in have:
        call("POST", "/v1/objects/message_template/records", {"name": name, "text": text})
print("Messages ready:", ", ".join(START))
