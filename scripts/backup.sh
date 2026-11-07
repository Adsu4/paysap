#!/bin/bash
# ==============================================================================
# PaySap Automated Daily Backup Script
# Retention: 14 Days
# Crontab schedule: 0 3 * * * /home/deployer/apps/boutique-paylink/scripts/backup.sh
# ==============================================================================

set -e

DATE=$(date +%Y-%m-%d_%H%M%S)
BACKUP_DIR="/home/deployer/backups"
APP_DIR="/home/deployer/apps/boutique-paylink"

mkdir -p "$BACKUP_DIR"

echo "📦 Starting PaySap backup at $(date)..."

# 1. Archive JSON data and environment config
tar -czf "$BACKUP_DIR/paysap_data_$DATE.tar.gz" -C "$APP_DIR" data .env

# 2. Dump PostgreSQL Database if DATABASE_URL is defined
if [ -n "$DATABASE_URL" ]; then
  echo "🗄️ Dumping PostgreSQL Database..."
  pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/paysap_db_$DATE.sql.gz" || echo "⚠️ pg_dump warning (skipped)"
fi

# 3. Purge backups older than 14 days to preserve disk space
find "$BACKUP_DIR" -type f -name "paysap_*" -mtime +14 -delete

echo "✅ Backup successfully created: $BACKUP_DIR/paysap_data_$DATE.tar.gz"
