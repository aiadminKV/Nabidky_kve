#!/usr/bin/env bash
#
# Daily sync cron wrapper.
# Logs output to data-model/sync/logs/ with timestamped filenames.
#
# Install (runs at 01:00 UTC daily):
#   crontab -e
#   0 1 * * * /absolute/path/to/scripts/cron-daily-sync.sh
#
# Or use launchd on macOS — see comments at bottom.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data-model/sync/logs"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%d_%H%M%S")
LOG_FILE="$LOG_DIR/sync_${TIMESTAMP}.log"

echo "=== KV Daily Sync — $TIMESTAMP ===" > "$LOG_FILE"

cd "$SCRIPT_DIR"

# Use the node/npx from the system or nvm
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:$PATH"

npx tsx daily-sync-v2.ts >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "" >> "$LOG_FILE"
echo "=== Exit code: $EXIT_CODE ===" >> "$LOG_FILE"

# Keep only last 30 days of logs
find "$LOG_DIR" -name "sync_*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE

# ─── macOS launchd alternative ──────────────────────────────────────
# Save this as ~/Library/LaunchAgents/com.kv.daily-sync.plist:
#
# <?xml version="1.0" encoding="UTF-8"?>
# <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
# <plist version="1.0">
# <dict>
#   <key>Label</key>
#   <string>com.kv.daily-sync</string>
#   <key>ProgramArguments</key>
#   <array>
#     <string>/absolute/path/to/scripts/cron-daily-sync.sh</string>
#   </array>
#   <key>StartCalendarInterval</key>
#   <dict>
#     <key>Hour</key>
#     <integer>1</integer>
#     <key>Minute</key>
#     <integer>0</integer>
#   </dict>
#   <key>StandardOutPath</key>
#   <string>/tmp/kv-sync-stdout.log</string>
#   <key>StandardErrorPath</key>
#   <string>/tmp/kv-sync-stderr.log</string>
# </dict>
# </plist>
#
# Then: launchctl load ~/Library/LaunchAgents/com.kv.daily-sync.plist
