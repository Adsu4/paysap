# PaySap production & pilot deployment

PaySap supports **PostgreSQL transactional persistence** (`STORAGE_DRIVER=postgres` / `DATABASE_URL`) as well as a **single-process JSON store** (`STORAGE_DRIVER=json`) for supervised pilots.
Gmail restricted-scope production approval and independently verified backup restoration
drills remain operational launch requirements. Do not advertise guaranteed uptime or
instant settlement from an email alert alone.

## Cloud deploys with GitHub Student Developer Pack

1. **Option A — Heroku (`$13/month` for 24 months via Heroku for GitHub Students; card verification required):**
   - Covers an Eco Dyno (`~$5/mo`) + Heroku Postgres Essential (`~$5/mo`) inside the `$13/mo` student credit.
   - Connect GitHub repo `Adsu4/paysap` (`main` branch) in the Heroku Dashboard (uses [`Procfile`](Procfile) and [`app.json`](app.json)), or run via Heroku CLI after pushing:
     ```bash
     heroku create paysap-store
     heroku addons:create heroku-postgresql:essential-0
     heroku config:set NODE_ENV=production HOST=0.0.0.0 TRUST_PROXY=1 STORAGE_DRIVER=postgres \
       APP_URL=https://paysap-store.herokuapp.com \
       ENCRYPTION_KEY=$(openssl rand -hex 32) \
       WEBHOOK_SHARED_SECRET=$(openssl rand -hex 32)
     git push heroku main
     ```
   - Attach a free 1-year `.me` (Namecheap), `.tech`, or `.dev`/`.app` (Name.com) Student Pack domain with automatic Heroku ACM SSL.

2. **Option B — Azure for Students (`$100 credit` for 12 months, no credit card required + 750 free VM hours/month):**
   - **Ubuntu Linux VM (free-tier eligible `B1s`/equivalent + local PostgreSQL + NGINX + Certbot):** Provision an Ubuntu 24.04 VM in Azure (open ports `80` and `443` in the NSG), clone `https://github.com/Adsu4/paysap.git` into `/var/www/paysap`, and run:
     ```bash
     DOMAIN=paysap.me bash /var/www/paysap/scripts/setup-ubuntu-vm.sh
     ```
   - Point DNS `A` records to the VM's public IP and run `certbot --nginx --redirect -d paysap.me -d www.paysap.me`.
   - **Or Azure App Service (Linux container via [`Dockerfile`](Dockerfile)):** Deploy with an external/Azure PostgreSQL database, setting `HOST=0.0.0.0`, `TRUST_PROXY=1`, `STORAGE_DRIVER=postgres`, `DATABASE_URL`, `APP_URL`, `ENCRYPTION_KEY`, and `WEBHOOK_SHARED_SECRET`.

## Prepare a host and domain

Use a commercially suitable subscription and verify the actual monthly allowance,
credit expiry, region/SKU availability, IPv4, persistent disk, egress and backup costs.
Student credits and first-year domain promotions are not permanent $0 guarantees.
Confirm applicable Azure commercial-use entitlement rather than inferring it from
software-download benefits. Domain redemption depends on actual student eligibility
and availability, with a paid renewal after the promotional period.

Provision a supported Ubuntu LTS host, persistent disk and a stable public address.
Use a non-root application user, SSH keys and source-IP-restricted SSH ingress.
Expose only ports 80/443 publicly; Node listens on loopback. Install a supported
Node.js 24 LTS release using its official distribution instructions, plus Git,
NGINX, Certbot with its NGINX plugin, PM2, age and rsync. Do not use Node.js 20.

Clone the repository to `/var/www/paysap` and grant only the application user write
access to its data directory. Do not copy development customer records or credentials
to production. Review any formerly tracked runtime data and rotate exposed secrets.

## Configure and verify the application

```bash
cd /var/www/paysap
npm ci
npm run build
npm test
cp .env.example .env
chmod 600 .env
```

Fill `.env` before starting. Generate **different** random values for `ENCRYPTION_KEY`
and `WEBHOOK_SHARED_SECRET` (for example, `openssl rand -hex 32` for each). Set the
actual HTTPS `APP_URL`, `DATABASE_URL` (and `STORAGE_DRIVER=postgres` for PostgreSQL,
or durable `DATA_DIR` with `STORAGE_DRIVER=json`), `PASSWORD_RESET_WEBHOOK_URL` if
using an email/notification relay for owner password recovery, and only the optional
integrations you intend to enable. Store the encryption key securely for disaster recovery.

`npm test` owns temporary synthetic data directories, separate child servers and
random local ports. It blocks external network calls and cleans up after itself.

## PostgreSQL setup, data migration & key rotation

1. Provision a PostgreSQL 15+ database and configure `DATABASE_URL` and `STORAGE_DRIVER=postgres` in `.env`.
2. Schema initialization (`migrations/001_initial_schema.sql`) runs automatically on startup via `PostgresStore.init()`, or can be applied explicitly with `psql "$DATABASE_URL" -f migrations/001_initial_schema.sql`.
3. To migrate existing JSON records from `DATA_DIR` into PostgreSQL:

```bash
npm run migrate
```

4. To rotate `ENCRYPTION_KEY` cleanly across stored IMAP and OAuth credentials in either JSON or PostgreSQL mode, preview and apply with:

```bash
OLD_ENCRYPTION_KEY="<old-hex-or-passphrase>" NEW_ENCRYPTION_KEY="<new-64-hex>" node scripts/rotate-encryption-key.js --write
```

The CSS is compiled and committed as `public/css/tailwind.css`; a prepared release
can install with `npm ci --omit=dev`. When changing markup or JS utility classes,
run `npm run build` and commit the regenerated CSS. CI checks it is current.

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Run the exact startup-registration command printed by PM2, then verify a reboot.
Keep exactly one process when using `STORAGE_DRIVER=json` (do not use cluster mode
with JSON snapshots). PostgreSQL mode (`STORAGE_DRIVER=postgres`) uses database
transactions and `FOR UPDATE` row locks across order settlement and stock updates.

## Bootstrap HTTPS in the correct order

Point the domain's DNS A records to the host and wait for them to resolve.
Replace both names in `nginx.conf` with the actual domain names first. Only include
`www` if its DNS is also configured.

```bash
sudo cp /var/www/paysap/nginx.conf /etc/nginx/sites-available/paysap
sudo ln -s /etc/nginx/sites-available/paysap /etc/nginx/sites-enabled/paysap
# Disable the default site if it conflicts with the chosen names.
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d YOUR_DOMAIN -d www.YOUR_DOMAIN
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

The supplied NGINX file is intentionally HTTP-only for first boot. Certbot adds the
certificate, HTTPS listener and redirect after validation; there are no missing
certificate paths to prevent startup. Do not overwrite the Certbot-modified config
on routine application releases. Add HSTS after confirming every required subdomain
works over HTTPS; do not enable preload automatically.

Verify HTTPS on a real phone, address save/refresh, opening and returning from UPI,
an unverified UTR staying pending, explicit owner confirmation, and shipping a paid
order. Test real low-value transfers using a merchant-authorized ingestion source;
simulation endpoints are disabled in production. Configure uptime/process/disk and
mailbox-lag monitoring with actual alerts, and redact bearer URLs from logs.

## Mailbox and webhook dependencies

Gmail `gmail.readonly` is restricted. Public apps processing that data through a
server normally need restricted-scope verification and an annual independent
security assessment unless an exception applies. Testing-mode refresh tokens expire
after seven days. A successful OAuth connection is not proof of launch approval.
Use least privilege and a dedicated bank-alert inbox where appropriate.

The webhook transport secret authenticates a configured sender service; it does
not by itself prove a bank credit. Production ingestion needs independently
authenticated message provenance, replay prevention and exact merchant/amount/UTR
matching. Keep unexplained or ambiguous credits in review, and retain a human
verification fallback. Avoid putting transport secrets in query strings.

## Encrypted off-host backup and restore

`scripts/backup.sh` requires `age`, `rsync`, `flock`, PM2 and Node. It stops the single
PM2 process briefly to snapshot related JSON files consistently, restarts it before
uploading, encrypts with an age public recipient, and fails if the off-host upload
fails. This pilot method creates a short scheduled interruption; a transactional
database and a tested online-backup strategy are needed to remove it.

Generate the age identity on your recovery machine. Keep the private identity there,
and provide only its public recipient to the production host. Configure a protected
wrapper/cron environment with:

```bash
export AGE_RECIPIENT='YOUR_AGE_PUBLIC_RECIPIENT'
export BACKUP_REMOTE='backup@YOUR_BACKUP_HOST:/backups/paysap/'
export BACKUP_DIR='/var/backups/paysap'
/var/www/paysap/scripts/backup.sh
```

Run as the PM2 application user and make `BACKUP_DIR` writable by that user. Configure
restricted SSH credentials to the backup host and create the remote directory in
advance. Capture failed exit statuses in monitoring; a cron schedule alone is not
backup verification. Local retention is 14 days after a successful upload. Configure
independent retention on the backup host too. `.env` is excluded: separately secure
the environment/encryption key recovery copy, without which mailbox tokens cannot
be decrypted.

Before relying on backups, download one onto a separate recovery environment,
decrypt it using `age --decrypt --identity PATH_TO_PRIVATE_IDENTITY BACKUP.age`,
inspect/extract the tar archive into an **empty** directory, start an isolated
recovery instance and verify orders, stock, sessions and bank configuration. Never
extract a restore over a live data directory. Record the recovery time and any
orders that could be lost between snapshots.

## Updates and rollback

CI verifies dependency installation, generated CSS, isolated regressions and backup
shell syntax on Node 24. Deployment is manual until a real host, secrets and recovery
procedure are configured; a successful verification run does not deploy anything.

Prepare and verify an identified release before applying it, take a verified backup,
retain the previous code/dependency lockfile, then restart the single PM2 process and
check readiness plus one merchant workflow. Roll back the code if checks fail.
Future data-format changes require a compatible rollback/migration plan first.

## Current reference pages

- [Azure Students allowance](https://azure.microsoft.com/en-us/free/students/)
- [Azure education FAQ](https://learn.microsoft.com/en-us/azure/education-hub/faq)
- [Student offer terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/)
- [Credit expiry and disabled subscriptions](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled)
- [Namecheap redemption](https://www.namecheap.com/support/knowledgebase/article.aspx/9687/35/how-to-register-a-domain-via-our-educational-promotion-at-ncme/)
- [Supported Node releases](https://nodejs.org/en/about/previous-releases)
- [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
