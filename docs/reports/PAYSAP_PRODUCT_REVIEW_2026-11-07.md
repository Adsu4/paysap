# PaySap product and production review

Reviewed 7 November 2026. Scope: seller onboarding, owner/staff dashboard, new-order creation, customer checkout, payment reconciliation, inventory, fulfillment, access control, tests, and the proposed Azure deployment.

## Assessment

PaySap addresses a useful, specific problem: turning a WhatsApp conversation into an organized order, payment record, delivery address, and fulfillment task. The strongest product direction is a dependable order workspace for small retailers selling through WhatsApp.

It is not ready for unattended real-money operation. There are confirmed ways to declare an unpaid order paid, assign a credit to the wrong store, expose customer details, and oversell stock. A pending checkout also throws a browser error during initialization. These are release blockers, regardless of visual quality or whether the server is online.

The current interface has useful foundations: large phone inputs, safe-area spacing, mobile order/inventory cards, a short basic sale form, and separate phone-app/desktop-QR payment presentations. Preserve those strengths while simplifying navigation, language, and the underlying state model.

The review assumes an intended commercial product with multiple merchants, because the application already implements merchant registration and separate stores. An invitation-only pilot is a more appropriate next milestone than an unrestricted public launch.

## Evidence and limits

- Reviewed the application source, production configuration, migration/backup scripts, CI, and existing tests.
- Inspected an isolated copy with synthetic merchant/order data in the browser: desktop login, owner overview, new sale, and customer checkout; the seller and checkout were also inspected at a 390px viewport.
- Browser inspection reproduced the pending-checkout initialization error and contradictory error/form screens. The phone-width seller view showed truncated labels and crowded controls.
- Five backend failures were reproduced in an isolated Node VM with synthetic data, a fake in-memory filesystem, disabled timers, and no external network: fabricated UTR acceptance, public order-data exposure, cross-store payment assignment, forged sender acceptance, and a debit notification being treated as a credit.
- Other findings below are source-confirmed. Stock races, restart/replay behavior, full-load capacity, real Android/iPhone UPI handoffs, real email delivery, refunds, and infrastructure recovery were not exercised end to end.
- Responsive viewport inspection is not a substitute for testing real phones, touch keyboards, WhatsApp's in-app browser, and installed UPI applications.
- The existing test suite was not run against the working application's records because it expects specific live merchants/sessions and performs mutations.
- Product source/configuration was left unchanged. This document is a proposed implementation backlog, not a claim that repairs have been applied.

Source references below use repository-relative filenames and one-based line numbers at review time.

## 1. Release blockers

| Priority | Finding and consequence | Evidence | Required change |
|---|---|---|---|
| P0 | An unused 12-digit number submitted by a customer can mark an order PAID without a bank credit, move it to packing, and decrement stock. A valid-looking reference is not proof of payment. | `server.js:1803`, `1848–1898`; isolated reproduction returned PAID with `customer_utr`. | Customer input may report a payment, never verify it. Store it as awaiting verification. Only authoritative payment evidence or an explicitly logged owner review may confirm receipt. |
| P0 | A credit for store B can settle store A's order when their references collide. The final update matches token OR reference globally after initially matching within a seller. | `server.js:1333–1350`, `2203`; reproduced with two stores. | Update the exact immutable matched order ID within its merchant. Enforce tenant scoping at every read and write; display references are not unique payment identities. |
| P0 | Public lifecycle events return the entire order. Address writes need no existing customer session and return the full order plus its session key. Predictable references can reach these routes. | `server.js:333–349`, `1701–1799`; public data exposure reproduced. | Accept high-entropy checkout tokens only on public routes. Return explicitly allowlisted public fields. Establish and check a customer session for sensitive changes; freeze or review address edits after packing/shipping. |
| P0 | Bank sender verification accepts substrings, including a legitimate bank domain followed by an attacker suffix. Missing sender can bypass the check. | `server.js:209–248`, `2093–2102`, `2735–2754`; forged-domain acceptance reproduced. | Parse an exact mailbox/domain and use trusted email-authentication provenance. A From string alone is not authentication. Fail closed when required evidence is absent. |
| P0 | The parser can take an amount from a debit email and settle a pending sale. It does not establish incoming direction or the beneficiary account. | `server.js:1995–2085`; debit-to-PAID reproduced. | Require positive incoming-credit classification, merchant account binding, currency, amount, transaction identity, and safe order association. Ambiguity goes to review. |
| P0 | Every successfully loaded pending checkout calls the poller before `pollCount` is initialized. It displays an inactive-link error over a working address/payment form and never starts automatic confirmation. | `public/js/checkout.js:138`, `140–144`, `1080–1085`; reproduced in browser. | Initialize all state before loading data. Render exactly one loading/error/address/payment/success screen. Add retry and a meaningful error, and verify automatic status changes. |
| P0/P1 | Simulation remains accessible in production to any owner and can target another merchant's order. A tenant owner can also overwrite global OAuth client configuration. | `server.js:2449–2467`, `2937–3050`. | Remove simulator routes from production. Keep platform configuration outside merchant settings and enforce a separate platform administrator boundary. |
| P1 | PM2 starts one worker per CPU, while each worker maintains its own JSON snapshots. Workers can overwrite orders, disagree about sessions, and process evidence repeatedly. | `ecosystem.config.js:5–6`; `server.js:67–105`. | Use one process as an interim containment measure. Move the live application to a transactional database before commercial launch or scaling. |

Additional privacy issue: the seller field is explicitly labeled “Internal Notes & Specifications,” but its value becomes `order.notes` and appears in customer checkout. Split private staff notes from customer-visible instructions and filter private fields at the API boundary. Evidence: `public/index.html:264`, `public/js/seller.js:1423–1444`, `public/js/checkout.js:184–186`.

## 2. Fix the commercial model before adding features

### Payment evidence

Model a bank/payment event separately from an order. Record merchant account, external transaction ID, credited amount in integer paise, currency, direction, occurrence time, receipt time, source, and verification result. Enforce uniqueness in the database and retain an audit trail.

The current amount-only fallback can assign an unrelated matching credit to the only pending order. Exact amount is a useful search hint, not sufficient evidence. Reference text may also be missing or ambiguous. Reject uncertain automatic matches and expose a reconciliation inbox with the evidence and a deliberate owner confirmation action.

There are two practical launch approaches:

1. A supported merchant payment integration with authenticated server-side transaction confirmation. Evaluate provider availability, onboarding, costs, and webhook guarantees before choosing it.
2. A small pilot with direct UPI, customer payment reports, and owner-reviewed bank evidence. Clearly label manual confirmation and never present it as independently automated bank verification.

Treat bank email as reconciliation assistance until provenance, parsing, account binding, replay prevention, backlog recovery, and operating requirements are demonstrated. A signed inbound webhook authenticates the integration sender; it does not automatically authenticate the original bank email or prove that an order was paid.

The README's claim about unique paise offsets is stale. Current creation code explicitly uses `payableAmt = baseAmt` at `server.js:1356–1357`. Keep the exact price and fix reliable association rather than reintroducing invisible amount adjustments. If a future adjustment is used, disclose it and handle rounding, collisions, stale links, and refunds explicitly.

### Separate payment, order, inventory, and delivery states

One PAID/PENDING flag plus a freely editable dispatch field cannot describe the business safely.

| Record | Proposed states or facts | Important rule |
|---|---|---|
| Order | Draft, awaiting payment, confirmed, cancelled, expired | Confirmation requires the agreed payment and stock policy. |
| Payment | No payment, reported, processing/review, verified received, refund pending, refunded | A customer's claim or app return does not mean received. Preserve real received money even if the order cannot be fulfilled. |
| Stock allocation | None, held until a real expiry, committed, released | Stock transitions and order updates occur in one transaction. |
| Fulfillment | Not ready, ready to pack, packed, shipped, delivered, return/exception | Readiness depends on valid payment, stock and required address. Shipping records carrier/tracking or an explicit local-delivery exception. |

Examples that must work:

- Two customers pay for the final item: retain both real payments; allocate one unit and put the other order into a fulfillment/refund exception.
- A payment arrives after cancellation or hold expiry: record it and request review; do not silently lose it or automatically resurrect the order.
- An order is cancelled before payment: the checkout must stop offering an apparently active sale, while still handling a late transfer.
- A refund is recorded: retain the original transaction and a separate refund record. Do not delete the original sale.
- A customer changes address after packing: require an explicit change workflow instead of silently modifying the shipping destination.

Current problems include unrestricted forward/backward dispatch transitions and cancellation that only changes dispatchStatus (`server.js:1963–1986`). No genuine reservation/expiry transaction supports the exclusive-reservation copy. Multiple pending links can target the last unit, and automatic bank settlement does not enforce stock allocation (`server.js:1239–1264`, `1280–1323`, `2249–2253`).

### Inventory and order contents

For boutique retail, size, color, quantity and the exact item matter more than extra dashboard metrics. Introduce order line items with immutable product/variant IDs, quantity, price snapshots and images. A first release can treat each size/color as its own SKU, provided stock is tracked for that SKU.

Do not silently invent stock. Saving a custom order to the catalog currently assigns stock 5 (`server.js:1312`). Ask for the real opening quantity, or mark availability as untracked. Give made-to-order products a lead time and capacity policy instead of pretending they are reserved physical units.

Use a transparent total: items, shipping, discount and final amount. Freeze the accepted total and merchant payment destination for the transaction. Handle edits through a new revision/link or an explicit adjustment. Validate currency values exactly; do not rely on permissive parseFloat input.

Postal lookup should suggest city/state and let the customer correct them. The current prefix fallback can return a guessed city as success (`server.js:3133–3183`). Lookup does not verify that a courier can deliver to a particular address.

## 3. A clearer product structure

### Merchant home: today's work

Replace the initial analytics-heavy owner overview with an operational home:

- Payments needing review.
- Paid orders ready to pack.
- Orders missing delivery information.
- Shipping/stock exceptions.
- A prominent New order action and a compact received-today summary.

Each count opens the relevant filtered queue. Give every order one recommended next action with a visible reason when it is blocked. Put conversion charts and team comparisons in Reports.

Use one navigation vocabulary across screen sizes: Home, Orders, Inventory, More; place Team, Reports and Settings under More on phones. New order should be the prominent creation action. Staff receive a permission-appropriate version of the same structure.

### New order

Recommended sequence:

1. Enter customer WhatsApp number; normalize common pasted +91 formats and show the intended recipient.
2. Search/select a product in one control, or choose Custom item. Avoid separate SKU input, description field and catalog dropdown competing for the same task.
3. Select size/color/quantity where relevant; show availability and exact total.
4. Create link once. Use a request idempotency key so retries/double taps cannot create duplicate orders.
5. Show the created order summary, Copy link and Open WhatsApp. Preserve the result if WhatsApp is unavailable or its popup is blocked.

Retain optional customer name and instructions, but label visibility explicitly. Keep draft values if the network fails, the app refreshes, or another order is paid. Opening a WhatsApp compose window does not establish that a message was sent.

### Canonical order detail

Use one order detail page for staff and owners with permissions applied server-side. Show item/variant/quantity, customer, delivery address, payment evidence and review state, fulfillment state, and a timestamped activity history. Provide copy actions where staff genuinely need them.

Record actor and reason for manual confirmation, cancellation, refund, stock adjustment, address override and shipping change. Keep customer tracking/status views simpler than internal records.

Consolidate the separate legacy `/dispatch` implementation into the same Orders workflow. Its mutation requests omit authentication headers and its search assumes string refs (`public/js/dispatch.js:101`, `231–255`); raw address interpolation also needs safe rendering (`135–141`, `192–196`). Whether a cookie masks the auth-header omission depends on the session; there should be one tested contract.

### Customer checkout

Lead with recognition and certainty:

- Merchant name/logo, recognizable item photo and exact size/color/quantity.
- Total payable including shipping, a concrete delivery estimate or merchant-stated lead time, and contact/returns information.
- Delivery details with persistent labels, appropriate autofill and numeric/tel keyboards. Allow a pickup flow when the merchant supports it.
- One clear payment action. On a real phone, prefer opening a UPI app; on desktop, prefer QR. Keep alternative methods accessible if detection is wrong.
- A checking-payment screen that accurately distinguishes pending bank confirmation from payment failure. Explicitly discourage paying again while a payment is under review.
- A verified receipt or a payment-reported/review state, followed by fulfillment information.

Keep “Already paid?” optional. Do not automatically focus the UTR input 15 seconds after page load or on every tab return (`public/js/checkout.js:332–339`, `955–966`, `1099–1105`). After a genuine UPI handoff, check the current backend state and offer help without stealing focus.

Show status freshness and a Check again action. The current poller silently stops after ten minutes and only reacts to PAID (`public/js/checkout.js:1052–1107`). It also needs cancelled/expired/unavailable/review/error states. Refreshing or reopening a checkout must recover safely.

## 4. Desktop and mobile design changes

### Visual direction

Keep the indigo identity and calm background. Reduce nested rounded panels, capsules, decorative icons, marketing assurances and repeated borders. A work tool should make the order and next action easiest to see.

Use a readable type scale: approximately 16px for main phone form text, 14–16px body/table content where practical, and 12–14px for secondary labels. Avoid important statuses and field explanations in 9–10px text. Prefer fewer meaningful surfaces, darker secondary text, consistent spacing, and one primary action per task.

Separate semantic colors from brand color: green only for actual confirmed success; amber for review/attention; red for failed/blocked actions. Do not make every badge look like a successful verification.

### Desktop

- Use a stable app shell with navigation and a clear content title. The current floating header plus KPI strip plus large rounded shell consumes space before the task.
- Make Orders a searchable, paginated work table with saved filters, sorting, accessible row actions and optional bulk shipping/export.
- Open order details in a panel or route without losing search, filter, scroll and selection.
- Place the order form beside a concise live summary; reveal sharing actions after creation. The current empty message/link preview consumes substantial attention before it is useful.
- Avoid multiple visual outlines inside a single input. Consistent input styling should cover both browser-native and enhanced controls.
- Add URL/history state so refresh, Back and deep links preserve the current task.

### Mobile

- Preserve large controls, safe-area handling and card-based order lists.
- At 390px, the owner role capsule and revenue label truncate; catalog option text is also clipped. Show shorter useful labels and move secondary identity details into an account menu.
- Replace the three product-entry controls with one searchable picker and a separate explicit Custom item option.
- Give the active form enough scroll padding above sticky actions and bottom navigation. Verify the final optional fields remain reachable with the keyboard open.
- Use a single reachable primary CTA, with consistent placement across steps. Do not let a sticky button hide validation or a focused field.
- Make order cards answer: who, what, how much, what state, what next. Put secondary details in the order view.
- Use native address autocomplete attributes and telephone/numeric input modes; preserve text across app switching.
- Test at 320, 360, 390 and 430px, landscape and zoom. The 390px seller page reported a 405px document scroll width during inspection; diagnose actual overflow rather than masking it with clipping.

Current source-specific interaction defects:

- Desktop alternate UPI link remains `href="#"`; only the phone button is bound (`public/pay.html:449`, `public/js/checkout.js:214–218`).
- Mobile QR helper values use `.displayVpa` and `.displayRefNote`, but the script only fills desktop IDs (`public/pay.html:487,496`, `public/js/checkout.js:209–210`).
- A payment on another order switches staff away from the new-sale builder (`public/js/seller.js:1545–1547`). Use a notification with View order instead.
- Polling rebuilds the active master view when any order changes (`public/js/seller.js:1588–1630`). Update changed records without destroying drafts, selection or focus.
- The offline notice promises later synchronization without an implemented mutation queue (`public/js/seller.js:149–157`). Preserve local drafts and say Reconnect to save, or implement a real idempotent queue and conflict handling.

### Accessibility

Allow browser zoom; remove `maximum-scale=1.0` and `user-scalable=no`. Provide persistent labels, keyboard focus visibility, accessible dialog semantics/focus trapping/restoration, announced validation/status messages, and reduced-motion support. Verify actual contrast and keyboard use rather than assigning an arbitrary accessibility score.

## 5. Trust, psychology, and useful measurement

The most persuasive design change is to make every statement accurate.

| Current wording/behavior | Better treatment |
|---|---|
| Verified Business appears if a store has a logo/location/Instagram | Show factual merchant details. Reserve verification badges for a documented verification process. |
| Reserved/exclusively reserved without a stock hold | Only show a real hold with its real expiry; otherwise describe availability honestly. |
| Instant bank verification | Show the actual confirmation state and source; describe timing only after measuring it. |
| Links sent incremented at creation | Track Created, Copy clicked and WhatsApp opened separately. Sent is unknown without a supported delivery signal. |
| Spreadsheet updated when only local order fields change | Say Order saved. CSV export is not a live spreadsheet integration. |
| TLS 1.3 256-bit Secure footer on every deployment | Avoid hard-coded technical security assurances. State useful, provable facts instead. |
| A follow-up nudge recovers up to 40% | Remove unsubstantiated conversion claims; measure the real result. |
| Fast Sale Creator / Stock CRM / Master Dashboard / Pitch | New order / Inventory / Store dashboard / WhatsApp message. |

A recognizable merchant, complete order details, transparent costs, a real contact, recoverable errors, and an accurate payment status reduce uncertainty. Treat this as a design hypothesis to validate with customers, not a guaranteed conversion uplift.

Onboarding should reach first value quickly: create owner account, configure store/payment destination, verify readiness through a controlled test, then create the first order. Solo merchants should not be forced to create staff. Offer staff invitations, catalog import and branding later.

Do not expose every merchant and staff name in public login dropdowns. Prefer a store-specific sign-in link/code and remember that store on the device. Avoid default PINs such as 1234 and broad, reusable shared access.

Follow-up should be controlled by the merchant with reasonable timing, contact history and opt-out handling. A customer who has just entered an address is not necessarily an abandoned sale. Suppress reminders for paid, cancelled, recently contacted and disputed orders.

Measure a few outcomes that correspond to real work:

- Time and errors creating an order; duplicate creation after retry.
- Share/open/address/payment-start/verified-payment events with honest definitions and deduplication.
- Payment confirmation latency, unmatched/ambiguous credits, false confirmations, and required owner intervention.
- Time from verified receipt to packed/shipped, fulfillment errors and stock conflicts.
- Checkout abandonment by step/device/network, plus merchant support requests.
- Merchant time saved versus their previous workflow and willingness to keep using the product.

Define a time window for reports. Paid receipts, refunds and net receipts should be distinguishable. Staff attribution should remain historical when staff profiles are renamed or removed. Do not log payment/customer data unnecessarily to obtain analytics.

## 6. Technical readiness

### Database and background work

Setting DATABASE_URL does not migrate the running app. `server.js` never uses PostgreSQL. The separate migration script expects existing tables and does not replace the JSON persistence layer. Implement schema migrations, a live data-access layer and transactional order/payment/stock changes.

Recommended core records: merchants, users/staff roles, sessions, products/variants, orders, order items, addresses, payment events, reconciliation decisions, stock reservations/movements, fulfillment records, activity events and durable background jobs.

Use uniqueness constraints and request/event idempotency. Store tenant IDs on relevant records and require tenant-scoped access throughout. Paginate the order API; it currently sends all filtered records and recomputes metrics (`server.js:1444–1578`). Separate small status updates from full order-list reloads.

Email ingestion needs durable cursors/deduplication, pagination/backlog processing, retry with backoff, quarantine for parse errors and a visible last-success/lag indicator. The current Gmail fetch is limited to 25 messages, has volatile deduplication, and can mark transiently failed messages as inspected (`server.js:2680–2793`). Missing UTRs currently receive generated EMAIL identifiers, which cannot establish durable bank-transaction identity (`server.js:2218`).

Do not rewrite the frontend framework merely for appearances. First separate payment/state logic, API contracts, rendering and background workers so behavior can be tested. A later framework change should have a concrete maintenance or interaction benefit.

### Security and privacy

- Reject missing/default production secrets at startup. The known encryption-key fallback must not be used in production (`server.js:110`).
- Hash staff PINs, remove predictable defaults, implement account/store-aware throttling and session revocation, and define owner recovery. Owner password changes currently leave other sessions active.
- Use consistent cookie/session protection; phase out auth tokens accepted in query strings (`server.js:402–404`). Do not confuse private auth tokens with public checkout capabilities.
- Enforce staff order visibility on individual-order endpoints as well as lists/exports (`server.js:1634`).
- Prevent unauthenticated product-detail access from bypassing merchant scoping (`server.js:1128–1143`).
- Require authenticated webhook ingestion, replay protection and strict schemas; configuration is currently optional (`server.js:2267–2277`). Do not put shared secrets in URLs.
- Bundle/version application CSS and scripts. The production page currently executes the Tailwind CDN and disables CSP (`server.js:21`). Add an appropriate CSP after removing inline/runtime dependencies.
- Restrict arbitrary tenant-supplied IMAP hosts/ports and outbound destinations to prevent internal-network access abuse.
- Render untrusted values safely, including legacy address markup; redact bank-email and customer details from routine logs.
- Define customer-data retention, access/export/deletion, merchant policies and contact/recovery flows. Keep sensitive details out of public checkout responses by construction.
- Runtime seller/product/settings JSON files are tracked. Replace real runtime data with sanitized fixtures and inspect Git history for exposed credentials; rotate any that were committed. Actual stored credentials were not displayed in this review.

### Tests and release evidence

Tests must start their own isolated app/database, seed synthetic fixtures, wait for readiness, assert outcomes and return a nonzero exit code on failure. Current tests depend on real local sessions/merchant IDs, and some print failure without failing the process. `test_pm_fixes.js` prints an unconditional success message. CI does not start the app before HTTP tests.

Some existing tests explicitly expect arbitrary customer UTRs to settle an order. Correct the requirement and tests together; making an unsafe behavior pass tests is not a release gate.

Required scenarios include forged/missing/debit alerts, duplicate/replayed/out-of-order events, same reference across merchants, account/currency/amount mismatch, under/overpayment, cancelled/expired/late payments, final-unit races, stock/refund recovery, anonymous/other-tenant access, address tampering and process restart.

UI acceptance includes valid pending checkout with no JavaScript errors; automatic receipt after verified status; slow/lost network and double tap; no draft loss on polling; keyboard-only operation and zoom; app-handoff denial/return; and safe recovery after a refresh.

## 7. Review of the $0 Azure/Namecheap plan

The plan is a possible starting point for a credit-funded development or pilot deployment after correction. It does not establish permanent free operation, an approved commercial entitlement, or guaranteed uptime. Sources were checked on 7 November 2026.

| Roadmap claim | Correction |
|---|---|
| Azure Students: no card, $100 | Correct for eligible students; credit is time-limited. Academic eligibility still has to be verified. [Azure Students](https://azure.microsoft.com/en-us/free/students/). |
| Free B1s for 12 months | Azure lists eligible free VM monthly allowances for new customers. Check the subscription's actual region/SKU/quota and separate disk/network allowances before provisioning. [Azure free-service list](https://azure.microsoft.com/en-us/free/students/). |
| The whole deployment costs $0 | Public IPv4 has a charge; storage, snapshots, backup, egress and monitoring need their own budget/allowance checks. Credits can cover costs temporarily. [Azure public IP pricing explanation](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses). |
| Student subscription is unquestionably appropriate for commercial launch | Confirm the intended use with Microsoft. The education FAQ describes educational/noncommercial purposes, while offer terms apply specific restrictions to Software Download Benefits. This is not sufficient evidence for a blanket commercial-VM ban, nor a reason to assume commercial permission. [Education FAQ](https://learn.microsoft.com/en-us/azure/education-hub/faq), [offer terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/). |
| 24/7 uptime | Continuous running is possible; uninterrupted availability is not guaranteed by a single VM, process and disk. Exhausted/expired credits can disable services. [Student subscription limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled). |
| Free custom .me | GitHub lists one year, subject to actual redemption eligibility and name availability. It is not a permanent free domain. Do not assume paysap.me is available. [GitHub Pack](https://education.github.com/pack), [Namecheap eligibility instructions](https://www.namecheap.com/support/knowledgebase/article.aspx/9687/35/how-to-register-a-domain-via-our-educational-promotion-at-ncme/). |
| Install Node 20 | Node 20 is now end-of-life. Use a supported LTS release, such as Node 24 after dependency compatibility checks. [Node release status](https://nodejs.org/en/about/previous-releases). |
| Connect Gmail and launch | The requested gmail.readonly scope is restricted. A public app using restricted data through servers ordinarily needs restricted-scope verification and annual third-party security assessment unless an exception applies. Resolve permitted use, approval, effort and possible cost before depending on it commercially. Testing-mode refresh tokens ordinarily expire after seven days for these scopes. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes), [verification/assessment requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [OAuth token expiry](https://developers.google.com/identity/protocols/oauth2). |

The provided commands also have concrete application-specific problems:

1. NGINX references TLS certificate files before Certbot creates them. A clean-machine nginx -t fails. Start with an HTTP-only ACME-capable configuration, obtain the certificate, then enable/test HTTPS.
2. Its static root is `/home/deployer/apps/boutique-paylink/public`, while the new clone path is `/var/www/paysap`. Align all paths, hostnames, users and service working directories.
3. PM2 clustering conflicts with JSON persistence. Run one process temporarily; the lasting repair is the transactional database.
4. Copying .env.example does not configure real secrets, OAuth redirects, allowed origin or storage. Validate the final environment before the service accepts traffic.
5. Generated links currently use req.protocol and Host (`server.js:1420`). Configure the exact trusted reverse proxy and a canonical validated HTTPS origin, so proxy deployments do not produce wrong-scheme or attacker-controlled links.
6. Use SSH keys and restrict SSH ingress. Expose the reverse proxy on 80/443 and keep the app/database ports private. Use a dedicated non-root service user and explicit update/recovery procedures.
7. Use reproducible installs (`npm ci --omit=dev`) and staged releases with rollback. Existing CI still targets DigitalOcean, old paths and Node 20, and uses a mutable third-party action revision.
8. The backup script uses old paths, stores backups on the same machine, includes secrets/customer data without encryption, and can report success despite a failed database dump. Cron also does not automatically load .env. Require off-host encrypted backups, failure alerts and a restore drill.
9. Add health/readiness endpoints and monitor application errors, database health, mailbox lag, disk/memory, certificate renewal and remaining credits. A PM2 restart alone is not availability engineering.
10. A 1GiB machine needs measured memory/load testing with the chosen database topology. An 800MB Node restart threshold leaves little room for the OS and other services; do not infer capacity from the VM merely booting.

## 8. Proposed delivery sequence

| Stage | Deliverable | Exit condition |
|---|---|---|
| A: Payment and access correctness | Remove customer self-verification/simulation; repair tenant boundaries and public responses; fix checkout initialization; split private notes; remove unsupported trust claims. | Adversarial payment/access tests pass, and valid pending checkout has no error or data leak. |
| B: Durable business behavior | Live transactional PostgreSQL, payment ledger/idempotency, stock allocation, cancellation/late payment/refund/fulfillment rules and durable ingestion jobs. | Restart/replay/concurrency tests preserve money, orders and stock; restore works. |
| C: Core experience | Simplified onboarding/new order, canonical detail, operational inbox, mobile navigation, accessible forms and recoverable network/app switching. | Representative merchants and customers complete the flows without coaching on desktop and real phones. |
| D: Operated pilot | Corrected deployment, commercial entitlement/cost plan, payment integration eligibility, monitoring/backups/rollback and support procedures. | A few consenting merchants process controlled transactions and real orders with reconciliation and support review. |
| E: Evidence-led expansion | Refine variants, bulk fulfillment, reports and integrations based on observed merchant work. | Reliable repeat use and measured value, with acceptable confirmation lag and support burden. |

The first milestone should be a complete, safe order-to-payment-to-shipping loop. Analytics, additional integrations, more animation and a frontend rewrite should follow evidence from that loop rather than precede it.
