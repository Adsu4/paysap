# PaySap state report — 8 November 2026

## Assessment

The application is substantially safer and more usable than the previous review. This pass repaired remaining access/payment gaps, replaced the customer checkout, redesigned the merchant home and order builder, and established an isolated regression gate. It is a stronger development build for supervised validation, **not an approval for unattended commercial payment processing**.

The primary remaining launch constraint is durable transactional storage. A single-process JSON application can pass functional tests and still lose consistency during a crash or partial multi-file write. PostgreSQL is not connected to this runtime. Real payment-source validation, backup restoration, merchant recovery and physical-device UPI testing also remain necessary.

This report supersedes the readiness conclusions in older roadmap documents. It distinguishes source changes and observed behavior from work that has not been implemented or independently validated.

## What your latest fixes changed

Your latest commit addressed important earlier findings: arbitrary customer UTRs no longer immediately settled an order, final bank matching used a merchant-scoped immutable identity, sender matching became stricter, debit classification was added, and production simulation was blocked. PM2 was already changed to a single process.

Reassessment found incomplete fixes and regressions:

- Checkout contained duplicate state declarations, preventing the script from parsing.
- The new public allowlist still returned an unmasked address, and address/session ownership was incomplete.
- Global platform administration still had a source-known default email and encryption-key/query-key bypass.
- Customer-visible and internal notes were not consistently separated across all public/session responses.
- Fulfillment allowed invalid transitions and had inconsistent cancellation/address locks.
- Owner onboarding still provisioned predictable staff credentials, and public login discovery listed other stores/staff.
- Existing tests relied on specific running-store records and did not provide an isolated release gate.

These findings were addressed in the current changes.

## Implemented in this pass

| Area | Result |
|---|---|
| Payment reports | Customer references remain pending and cannot silently turn into verified receipt. Review-only mode also applies when a reference matches a stored email receipt. |
| Bank evidence | Exact configured senders, credit/debit classification, persistent receipt deduplication, order/account scope, amount/time checks and a review queue. Amount-only matching does not automatically settle an unrelated order. |
| Safe operating default | Email auto-confirmation is off unless explicitly enabled. Receipts are retained for owner review. A successful ingestion response is not advertised as independent proof that an order was paid. |
| Owner confirmation | Accessible dialog showing order/customer/amount, payment method, reference and review note. UPI references are validated, decisions are logged, and matching receipts are allocated after owner confirmation. |
| Public access | Random token lookup, explicit public fields, masked address/customer data, session-owned address edits and private-note filtering. Human-readable references require authenticated access. |
| Merchant/staff isolation | Own-sale access for staff, owner-only cancellation, hashed new PINs, migration of legacy PINs on successful login, revocation when staff are removed/reset, and no implicit platform administrator. |
| Fulfillment | Paid/address/tracking prerequisites, allowed forward transitions, closed-checkout handling, packed/shipped address locks, stock-conflict review and refund-required state after paid cancellation. |
| Exact money/retries | Strict finite integer-paise validation, exact displayed decimals and seller-scoped idempotency keys for retries. A changed payload cannot reuse an earlier request key. |
| Inventory | Last-unit guard, no negative decrement, and no invented stock of five when saving a custom item. Untracked availability remains explicitly untracked. |
| Onboarding | Owner-first sign-in, solo-store signup, optional explicit staff creation and exact store lookup instead of a global directory. |
| Merchant home | Operational queues for payment review, packing, missing address and delivery; prioritized next steps; reports folded away; unallocated receipt visibility. |
| New order | Searchable catalog/custom item, normalized pasted phone numbers, exact total, separate private/public notes, tab-scoped drafts, recovery after refresh and explicit sharing after creation. |
| Live updates | No navigation away from a new order when another payment arrives, guarded overlapping polls, editing-aware refreshes, unsaved tracking preservation and route/history state. |
| Checkout | One mutually exclusive loading/error/address/payment/review/receipt state; mobile UPI/desktop QR; working alternate links; voluntary reference help; support; retry/status freshness; cancellation and stock/review states. |
| Trust/copy | Removed unsupported verified/reserved/sent/synchronized assurances in active flows. An app handoff is separated from payment receipt. Generic CSV export is labeled accurately. |
| Address correctness | Prefix-based guessed cities removed. If exact lookup fails, the customer can enter city/state manually. Lookup is not represented as proof of deliverability. |
| Accessibility | Zoom allowed, visible focus, persistent form labels, native confirmation dialog, modal focus handling, announced status/errors, reduced-motion support and larger phone controls. |
| Delivery/runtime | Supported Node configuration, single-process PM2, loopback app binding, HTTP-first TLS bootstrap, canonical URL, secret validation, resource CSP and consistent API errors. |
| Backup/CI | Reproducible dependency lock, compiled local CSS, real isolated test gate, no fictional successful deployment, encrypted off-host backup procedure with error propagation. |

### Intentional behavior changes

1. **Creating an order no longer automatically opens WhatsApp.** It creates the record and exposes sharing controls. Opening WhatsApp is deliberate; successful message delivery is not claimed.
2. **Email auto-confirmation defaults to off.** `ENABLE_EMAIL_AUTO_CONFIRMATION=0` leaves receipts for owner review. Enabling it is an integration/operating decision, not a cosmetic toggle.
3. **Public links must contain the random token.** Old links containing only a sequential/display reference need replacement. All active sharing paths now use token links.
4. **Staff credentials are no longer recoverable from responses.** New/reset PINs are hashed. Owners set a replacement PIN; they do not reveal a stored plaintext PIN. Existing weak PINs should be reset by their owners.
5. **Closed/packed/shipped orders restrict edits.** Paid cancellation creates refund work; it does not execute a refund or pretend the original receipt vanished.
6. **New passwords require at least ten characters.** Password changes require the current password and revoke other store sessions. Failed validation does not partially apply profile edits.
7. **Courier shipping needs an address and tracking number.** Local pickup/local-delivery exceptions need a separate explicit product flow before being offered.

## Design and usability state

The merchant workspace preserves the original rounded cards, floating white desktop shell, pill navigation and soft depth. Lavender remains the default; owners can choose five other coordinated palettes. The phone dock places order work and creation within reach. Dense analytics no longer dominate the default landing page. Orders now use six desktop columns and compact expandable mobile cards, with visible counted filters, search and pagination.

The form has one searchable catalog entry point rather than three competing product controls. The created link and total are stable until the merchant starts the next order, preventing accidental sharing of an old link alongside edited price text. Drafts are scoped to the merchant/staff session and kept in the current tab; logout clears that draft. Offline copy describes what is actually saved.

Checkout is now a focused customer surface with scoped CSS and explicit progress. There are no fake business-verification badges or automatic UTR focus changes. Payment reporting suppresses repeat-payment encouragement and waits for confirmed server state. The customer can contact the store or return to the original conversation if no contact is available.

The legacy order-detail surface was retained for compatibility, with truthful creation/payment/activity labels, a review panel, an owner confirmation dialog and cancellation controls. Further simplification into one consistent order detail route remains worthwhile; it should follow a tested data model rather than another layer of visual patches.

Screenshots use synthetic records:

- [Desktop home](artifacts/review-2026-11-08/desktop-home.jpg)
- [Mobile home](artifacts/review-2026-11-08/mobile-home.jpg)
- [Mobile checkout](artifacts/review-2026-11-08/mobile-checkout.jpg)

## Verification

The regression runner owns a temporary synthetic DATA_DIR, random local port and child server. External server network access is blocked. It does not reuse merchant sessions or store records. Failures produce a nonzero exit status and fixtures/processes are cleaned up.

**Current result: 30 tests passed, 0 failed.** This includes theme contrast/persistence, current themes on existing checkout links, default-denied inventory editing, owner grant/revocation for active staff sessions, and strict permission flags. JavaScript syntax checks, the local CSS build, backup shell syntax, and `git diff --check` also passed. The CSS build reports an outdated Browserslist metadata advisory; it does not fail the build.

The current suite covers authentication/roles, public field filtering, cross-merchant access, customer references, duplicate allocation, address ownership/locks, shipping transitions/tracking, production simulator blocking, staff revocation, concurrent references, idempotent retries, strict money, private lifecycle responses, solo onboarding/hashed PINs, cancellation, forged/debit bank receipts, default owner review, final-unit stock conflict, refund-required state, settings atomicity/session rotation, headers/readiness/error contracts, compiled page boot, unsafe mailbox destinations and offline postal lookup.

Browser checks used disposable synthetic accounts/orders and included:

- Owner login, operational home, catalog search and pasted +91 numbers.
- Creating a ₹799.50 link without losing decimals or automatically sending a message.
- Reloading a created link and restoring an unfinished ₹1,299.75 phone draft.
- Customer address save, mobile payment presentation, voluntary UTR reporting and a pending review state without a success receipt.
- Owner confirmation using the native dialog and accurate update of payment totals.
- Exact staff-store discovery and staff PIN login with permission-appropriate navigation.
- Desktop at 1280px and phone-width views at 390px/320px. Inspected merchant views had no horizontal document overflow.
- No browser JavaScript errors in the inspected core flows.

Passing this evidence does not establish load capacity, browser/device universality, bank-template coverage, source account identity, financial reconciliation completeness or infrastructure availability. Real Android/iPhone keyboards, WhatsApp in-app browsers and installed UPI apps were not physically exercised. Azure deployment, actual certificate issuance and backup restoration were not performed.

## Remaining launch blockers and product work

### P0 — transactional payment/order storage

Implement the live PostgreSQL data layer and migrations, including a payment event ledger, unique transaction identity, stock movements/reservations, order revisions and transactional settlement. Test crashes/restarts between related updates. JSON writes remain synchronous and separate; one process avoids worker collisions but does not make multi-file updates atomic. Corrupt-file recovery and migration/cutover need explicit procedures.

Do not add replicas or PM2 clustering before this is complete. The experimental migration script is not the running application's persistence implementation.

### P0 — real settlement integration

Choose and validate the actual merchant payment source, including destination-account binding, sender provenance, currency/amount identity, event replay, delayed/partial/overpayment, reversal and late-payment resolution. Email authentication and an amount/reference match alone are not universal financial proof. Keep supervised review as the default until this is established.

Resolve Gmail eligibility, scopes, verification/security-assessment requirements and recovery/reconnection behavior for the actual commercial deployment. A test OAuth flow does not demonstrate an approved production integration.

### P1 — money and customer recovery

Refund-required status is implemented; refund execution, partial refunds, returns, charge/dispute handling and an immutable accounting ledger are not. An out-of-stock receipt is retained for review, but the product still needs a complete resolution flow rather than relying on staff conversation alone.

Implement merchant password/account recovery, email ownership verification, stronger account-specific throttling, owner MFA where appropriate, device/session management and durable audit/event retention. Review historically tracked runtime data and rotate any exposed credentials without silently changing existing customer/merchant access.

### P1 — deploy and operate

Configure the real host/domain/secrets, verify SSL/renewal and rollback, run restore drills and add actionable monitoring for process errors, mailbox lag, disk/memory and credit expiry. Backup tooling now fails honestly and supports encrypted off-host copies, but no real restore has been proven. The JSON backup procedure deliberately pauses writes; it is not zero downtime.

Set cost/availability expectations using the actual subscription. Student/first-year offers do not establish permanent free commercial hosting or guaranteed availability. See DEPLOYMENT.md.

### P1/P2 — complete retailer workflows

Add order line items, explicit quantities, variant-level inventory, shipping/discount components, pickup/local delivery, price revisions and real lead times. Current orders remain one SKU/unit; size/color can be part of that SKU but there is no complete variant matrix/cart.

Add server pagination/indexed search as data grows. Avoid returning the entire order history and recalculating all metrics on every poll. Consolidate remaining legacy order-detail markup into a focused summary/history/action view after the state model stabilizes.

Define merchant-facing shipping/return/privacy policies and customer data retention/export/deletion. Support store policy configuration without inventing terms or delivery promises on the merchant's behalf.

### P2 — validate product value

Run moderated sessions with a few target merchants and customers. Measure time to create/share an order, duplicate/retry rate, confirmation latency, owner intervention, fulfillment mistakes, support requests and repeat merchant use. Follow-up timing should avoid paid/cancelled/recently contacted customers and respect opt-out expectations.

Use those observations to decide whether bulk dispatch, catalog import, customer history, team reports or integrations are the next most valuable investment. Avoid adding more dashboards before the core work is consistently easier.

## Recommended next milestone

Complete transactional persistence and real settlement-source validation, then conduct a small supervised merchant pilot with an actual restore/recovery exercise. This build is meaningfully improved, but calling it perfect or production-ready would exceed the evidence.
