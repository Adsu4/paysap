#!/usr/bin/env bash
# Encrypted off-host backup for PaySap.
# - When DATABASE_URL is set, performs an online pg_dump without stopping the app.
# - Otherwise, briefly stops the single JSON PM2 process for a consistent snapshot.
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/var/www/paysap}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/paysap}"
PM2_APP="${PM2_APP:-paysap-api}"
: "${AGE_RECIPIENT:?Set the age public recipient used for encrypted backups}"
: "${BACKUP_REMOTE:?Set an off-host rsync destination, for example backup@host:/backups/paysap/}"
[[ "$BACKUP_REMOTE" == *:* ]] || { echo 'BACKUP_REMOTE must be an off-host rsync destination.' >&2; exit 1; }
for command in age rsync node flock; do
  command -v "$command" >/dev/null || { echo "Missing required backup command: $command" >&2; exit 1; }
done
mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo 'Another backup is already running.' >&2; exit 1; }

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v pg_dump >/dev/null || { echo "Missing required command for PostgreSQL backup: pg_dump" >&2; exit 1; }
  archive="$BACKUP_DIR/paysap_pg_$(date -u +%Y-%m-%d_%H%M%S).dump.age"
  staging="$archive.partial"
  trap 'rm -f -- "$staging"' EXIT
  pg_dump --format=custom "$DATABASE_URL" | age --recipient "$AGE_RECIPIENT" > "$staging"
  mv -- "$staging" "$archive"
else
  [[ -d "$DATA_DIR" ]] || { echo 'DATA_DIR does not exist.' >&2; exit 1; }
  for command in pm2 tar; do
    command -v "$command" >/dev/null || { echo "Missing required backup command: $command" >&2; exit 1; }
  done
  archive="$BACKUP_DIR/paysap_data_$(date -u +%Y-%m-%d_%H%M%S).tar.gz.age"
  staging="$archive.partial"
  restart_needed=0
  cleanup() {
    local result=$?
    if (( restart_needed )); then
      pm2 restart "$PM2_APP" >/dev/null || { echo 'CRITICAL: PaySap failed to restart after backup.' >&2; result=1; }
    fi
    rm -f -- "$staging"
    exit "$result"
  }
  trap cleanup EXIT

  pm2 jlist | PM2_TARGET="$PM2_APP" node -e '
    let input = ""; process.stdin.on("data", x => input += x);
    process.stdin.on("end", () => {
      try {
        const matches = JSON.parse(input).filter(p => p.name === process.env.PM2_TARGET);
        if (matches.length !== 1 || matches[0].pm2_env.status !== "online") process.exit(1);
      } catch { process.exit(1); }
    });
  ' || { echo 'Expected exactly one online PaySap process; backup was not started.' >&2; exit 1; }

  restart_needed=1
  pm2 stop "$PM2_APP" >/dev/null
  tar -czf - -C "$DATA_DIR" . | age --recipient "$AGE_RECIPIENT" > "$staging"
  mv -- "$staging" "$archive"
  pm2 restart "$PM2_APP" >/dev/null
  restart_needed=0
fi

rsync --archive -- "$archive" "$BACKUP_REMOTE"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'paysap_data_*.tar.gz.age' -o -name 'paysap_pg_*.dump.age' \) -mtime +14 -delete
echo "Encrypted backup copied off-host: $(basename "$archive")"
