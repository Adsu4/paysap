# PaySap

A store workspace for WhatsApp orders: create a checkout link, collect delivery details, review payment and manage fulfillment. The application uses Express and browser JavaScript, with locally compiled CSS.

## Current status

PaySap is a modular Express + browser-JavaScript application supporting **PostgreSQL persistence** (`STORAGE_DRIVER=postgres` / `DATABASE_URL` via `PostgresStore` with `BEGIN`/`COMMIT` transactions and `FOR UPDATE` row locking) as well as a **single-process JSON store** (`STORAGE_DRIVER=json`) for local demos and pilots. Read [deployment instructions](DEPLOYMENT.md) and historical notes in [docs/reports/](docs/reports/) before using customer records.

Customer UTRs are payment reports, not proof of receipt. Email receipts require owner review by default. Owners can record an independently checked UPI/bank receipt or cash payment through an audited confirmation dialog. Cancelled paid orders enter `REFUND_REQUIRED` and support owner-audited full/partial refund resolution logging (`REFUNDED` / `PARTIALLY_REFUNDED`); refund recording creates an operational ledger record and does not transfer money automatically.

## Develop and verify

Use a supported Node.js release compatible with `package.json`.

```bash
npm ci
npm run build
npm test
```

`npm test` starts isolated temporary servers on random loopback ports, blocks external network calls, runs regression, theme, mailbox, security, pagination, multi-item, refund-logging, password-reset, and mocked `PostgresStore` transaction tests, and cleans up after itself.

```bash
npm run demo
```

The demo serves at `http://127.0.0.1:3117`, uses disposable synthetic records, disables bank polling, and prints its test-only login. It removes its temporary records when stopped normally. Set `DEMO_PORT` to use another port. It is the recommended way to review UI changes without touching local store data.

Owners can choose Lavender, Ocean blue, Forest, Rose, Warm sand or Slate in **Settings → Store Profile → Store colours**. Preview a palette, then use **Save colour** to apply it to the workspace and existing customer checkout links. This saves the colour independently of unfinished profile edits.

Inventory editing is available to owners and staff explicitly granted **Inventory Access** in **Settings → Team & Staff PINs**. New staff default to no editing access; revoking a grant blocks further API edits immediately. Other staff can still select products when creating orders.

For normal development, configure `.env` and run `npm run dev`. Production configuration, PostgreSQL setup, encryption key rotation, TLS, backups and deployment are described in [DEPLOYMENT.md](DEPLOYMENT.md).

## Architecture & Product flows

- **Modular backend (`src/`):** `src/app.js`, `src/config/env.js`, `src/middleware/{security.js,auth.js,rateLimit.js}`, `src/services/{orderService.js,mailboxService.js}`, `src/storage/{jsonStore.js,postgresStore.js,index.js}`, and `src/routes/{authRoutes.js,storeRoutes.js,productRoutes.js,orderRoutes.js,bankRoutes.js,utilityRoutes.js}`. `server.js` is the entrypoint.
- **Security & CSP:** Strict Content-Security-Policy (`script-src 'self'`, `script-src-attr 'none'`) with zero inline `<script>` blocks or `on*=` attributes in HTML/JS templates (`public/js/auth.js`, `public/js/ui-events.js`, `public/js/checkout.js`). Authentication uses `HttpOnly` `SameSite=Lax` cookies protected by CSRF origin validation (`Origin` / `Referer` / `Sec-Fetch-Site`), per-account/PIN login lockouts, and single-use hashed password reset tokens (`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`).
- **Home:** reported payments, packing queue, missing addresses, delivery follow-up, refund tasks, and unallocated bank receipts.
- **New order:** customer number, multi-item order builder (`items[]` with searchable catalog items, quantities, shipping charge, and discount), private notes and customer-visible instructions. Create first, then explicitly share.
- **Checkout (`public/pay.html`):** itemized bill breakdown, delivery details, phone UPI or desktop QR, voluntary reference reporting, pending/review state, confirmed receipt, and refund status display.
- **Orders:** lightweight summary polling (`GET /api/orders/summary`), server-side pagination/filtering (`GET /api/orders?page=&limit=`), owner payment review, guarded fulfillment transitions, owner refund resolution logging (`POST /api/orders/:tokenOrRef/refund`), tracking and CSV download.
- **Staff:** exact store lookup, explicit hashed PIN credentials, permission-scoped orders and optional inventory access.

The server returns random token links for customer checkout. Human-readable references are for authenticated staff; old customer links using only sequential references must be replaced with token links.

## Important operating boundaries

- **Persistence drivers:** Configure `DATABASE_URL` (and optionally `STORAGE_DRIVER=postgres`) for PostgreSQL with schema `migrations/001_initial_schema.sql`. Use `npm run migrate` (`scripts/migrate_json_to_postgres.js`) to import existing JSON snapshots into PostgreSQL. If using JSON mode (`STORAGE_DRIVER=json` or `DATABASE_URL` unset), run **at most one application process**.
- Production startup requires unique `ENCRYPTION_KEY`, `WEBHOOK_SHARED_SECRET` and a canonical HTTPS `APP_URL`. Keep a recovery copy of `ENCRYPTION_KEY`. To rotate `ENCRYPTION_KEY` without losing stored IMAP/OAuth credentials, run `OLD_ENCRYPTION_KEY=... NEW_ENCRYPTION_KEY=... node scripts/rotate-encryption-key.js --write`.
- Set `PASSWORD_RESET_WEBHOOK_URL` if you want owner password-reset tokens delivered to a mail/notification relay. Without it, public API responses never expose raw reset tokens.
- Email checks and confirmation mode are controlled separately in **Settings → UPI & Banking → Email monitoring**. Use **Save email settings** to persist these controls independently of profile edits. Automatic mode requires authenticated bank evidence, a matching order/reference, amount and receipt time; other receipts stay in review. `ENABLE_EMAIL_AUTO_CONFIRMATION` remains the legacy default for stores without an explicit choice. A per-store review or automatic selection takes precedence.
- Gmail production eligibility/verification, real-device UPI testing, and actual backup restoration drills remain launch responsibilities.
- CSV download is a generic order export, not a direct courier or spreadsheet integration.
- Runtime merchant files (`data/*.json`) must stay out of version control. Review previously committed data and rotate any exposed credentials; ignoring a path does not erase Git history.

## Styling

Run `npm run build` after changing utility classes in public HTML/JavaScript. Commit the generated `public/css/tailwind.css`; production runtime does not execute the Tailwind CDN. `public/css/app.css` contains the workspace design, while customer checkout has scoped styles. CI checks that generated CSS is current.
