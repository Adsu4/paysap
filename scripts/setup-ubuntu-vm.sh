#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 Linux VM (e.g. Azure for Students VM) for PaySap.
# Run with sudo on the VM after cloning into /var/www/paysap.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/paysap}"
DOMAIN="${DOMAIN:-paysap.me}"
DB_NAME="${DB_NAME:-paysap}"
DB_USER="${DB_USER:-paysap}"

# Add 1 GB swap on low-memory VMs (e.g. Standard_B1s) so npm ci / Tailwind build never OOM
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1800000 ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "[1/5] Installing Node.js 24, PostgreSQL, NGINX, Certbot, and PM2..."
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx postgresql postgresql-contrib age rsync
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pm2

echo "[2/5] Configuring local PostgreSQL database '${DB_NAME}'..."
DB_PASS="$(openssl rand -hex 24)"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "[3/5] Installing Node dependencies and building CSS in ${APP_DIR}..."
cd "${APP_DIR}"
npm ci
npm run build

if [ ! -f .env ]; then
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  cat > .env <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=loopback
APP_URL=https://${DOMAIN}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
WEBHOOK_SHARED_SECRET=${WEBHOOK_SECRET}
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
PGSSLMODE=disable
DATA_DIR=${APP_DIR}/data
ENABLE_EMAIL_AUTO_CONFIRMATION=0
EOF
  chmod 600 .env
  echo "Created ${APP_DIR}/.env with generated secrets. Back up ENCRYPTION_KEY securely!"
fi

echo "[4/5] Applying PostgreSQL schema migration..."
set -a; source .env; set +a
psql "${DATABASE_URL}" -f "${APP_DIR}/migrations/001_initial_schema.sql" || true

echo "[5/5] Configuring NGINX and PM2..."
sed "s/paysap\.me/${DOMAIN}/g" "${APP_DIR}/nginx.conf" > /etc/nginx/sites-available/paysap
ln -sf /etc/nginx/sites-available/paysap /etc/nginx/sites-enabled/paysap
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

pm2 start "${APP_DIR}/ecosystem.config.js"
pm2 save
pm2 startup systemd -u root --hp /root || true

echo ""
echo "Done! Next step once DNS points to this VM's public IP:"
echo "  certbot --nginx --redirect -d ${DOMAIN} -d www.${DOMAIN}"

