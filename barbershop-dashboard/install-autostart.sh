#!/bin/sh
# Makes the MICROSPACE calendar, numbers and texts pages start by themselves when you log in to this Mac.
# Run again after changing server.mjs. It copies the page and the CRM's ops key to a private folder outside the Desktop
# (background programs can't read the Desktop without asking), then starts it with launchd.
set -e
D="$HOME/Library/Application Support/MICROSPACE"
mkdir -p "$D" && chmod 700 "$D"
cp "$(dirname "$0")"/*.mjs "$D/"
mkdir -p "$D/assets" && cp "$(dirname "$0")"/assets/* "$D/assets/"
grep -o 'Ops key[^:]*: *hlcrm_[A-Za-z0-9_]*' "$HOME/Desktop/CRM-SECRET-KEYS.txt" | grep -o 'hlcrm_[A-Za-z0-9_]*' > "$D/ops-key"
chmod 600 "$D/ops-key"
P="$HOME/Library/LaunchAgents/com.microspace.dashboard.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$P" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.microspace.dashboard</string>
  <key>ProgramArguments</key><array><string>$(command -v node || echo /usr/local/bin/node)</string><string>$D/server.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>HLCRM_OPS_KEY_FILE</key><string>$D/ops-key</string><key>SHOP_TIMEZONE</key><string>${SHOP_TIMEZONE:-America/Chicago}</string></dict>
  <key>WorkingDirectory</key><string>$D</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/microspace-dashboard.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/microspace-dashboard.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/com.microspace.dashboard" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$P"
echo "Started. Open http://localhost:8790"
