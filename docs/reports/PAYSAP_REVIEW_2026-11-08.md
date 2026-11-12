# PaySap review — 8 November 2026

The main local email failure has a concrete explanation: saving the profile can turn monitoring off, while the interface continues to say Gmail detection is active. Automatic settlement is independently disabled when ENABLE_EMAIL_AUTO_CONFIRMATION is unset. These are separate conditions.

This review inspected current source and local configuration, ran the isolated regression suite, and reproduced four application failures with mocked dependencies. It also checked the installed IMAP library's actual download request. No real mailbox was contacted, no payment was confirmed, and no application code or merchant records were changed by this review. Running-process environment overrides were not inspected, so file configuration is not proof of a running process's effective environment.

## Confirmed bugs, in recommended repair order

### 1. Saving store details silently stops email monitoring — high priority

Location: public/js/seller.js:2947 and server.js:1193.

The profile save handler reads setBankMonitoringActive, but that input no longer exists in public/index.html. The missing input becomes false, which is included in the banking settings and persisted by the server. An owner can connect Gmail, edit an unrelated profile field, save, and unintentionally stop all email monitoring.

Evidence: ran the actual save function with a mocked DOM matching the missing control and captured monitoringActive:false in its request. The locally saved connected store currently has monitoringActive:false.

Fix: preserve monitoring state during ordinary profile saves. Give monitoring its own explicit, server-backed switch. Test that changing a name or logo never disables it.

### 2. The customer-reference route accepts receipts too old for an order — high priority

Location: server.js:1997–1999; compare server.js:2224.

The incoming-email path rejects receipts older than the order's allowed time window. The checkout UTR path only checks merchant, transaction reference, authentication, allocation and amount before settling. It omits the timestamp check.

Impact: with automatic confirmation enabled, a matching, authenticated but unallocated old receipt can settle a newer order. This requires a known matching reference; it is not an arbitrary-reference bypass.

Evidence: executed the actual UTR handler with synthetic records; a receipt from January 2025 triggered settlement of an order created in November 2026.

Fix: use one shared receipt-validation/allocation function for both routes, including receipt time, amount, merchant, reference, order identity and allocation checks. Add a regression for old receipts on the customer-reference route.

### 3. IMAP requests the wrong email content — high priority for IMAP users

Location: server.js:2770.

client.download(uid, ['source']) does not request the complete raw message. In the installed ImapFlow version it asks for a body section called source, which does not provide the intended raw email to the parser.

Evidence: invoked the installed library with a mocked transport and inspected its generated fetch request: bodyParts contained key:'source'; query.source was absent.

Fix: request the full raw message using the library's documented argument form, then parse its returned stream. Test multipart and plain-text alerts. My earlier suggestion of a demonstrated UID/sequence mismatch was inaccurate: the current search and download both default to sequence numbers. The confirmed defect is the content-download argument.

### 4. The interface reports active monitoring when it is stopped or broken — medium priority

Location: public/js/seller.js:2459–2490.

The green active label depends on Google being connected. It ignores monitoringActive and lastError. The Google connection toast also promises automatic settlement without checking the separate confirmation flag.

Impact: the owner sees a healthy-looking connection even when no emails are being checked, or when receipts will only enter owner review.

Fix: show separate states for connected, paused, checking, failed, last successful check, and automatic confirmation versus owner review. Explain the next action for each state.

### 5. Expired/broken OAuth access can fail silently — medium priority

Location: server.js:2615–2668.

Token refresh can return null. pollStoreGmail then exits before updating lastCheckedAt or recording a useful lastError. A failed OAuth connection is also preferred over the configured IMAP fallback whenever connected remains true.

Evidence: executed pollStoreGmail with a mocked token failure. lastError stayed empty and lastCheckedAt stayed unchanged.

Fix: persist a safe, actionable connection error and attempted-check timestamp; distinguish an attempted check from a successful check. Reconnect when necessary. Make fallback policy explicit rather than silently bypassing configured fallback credentials.

### 6. Opening a bank alert can make IMAP miss it — medium priority

Location: server.js:2758.

The IMAP search includes only unread messages. If the owner or another mail client marks an alert read before the next poll, it is excluded from payment processing.

Fix: track processed mailbox UIDs and UIDVALIDITY, and inspect a bounded recent-message window regardless of read state. Do not use the user's unread flag as the payment-processing queue.

### 7. Empty-inbox checks leave the IMAP connection open — medium priority

Location: server.js:2759–2763 and server.js:2811.

When no unread messages exist, the function returns from inside the mailbox-lock block. The lock is released, but execution skips client.logout(). Repeated checks can leave connections open until the server closes them.

Evidence: executed checkStoreInbox with a mocked empty inbox. The lock released once; logout was never called.

Fix: close the client in an outer finally block on success, early return and error. Test empty inboxes and parser failures.

## Configuration blockers, distinct from bugs

- In the local .env file, ENABLE_EMAIL_AUTO_CONFIRMATION is unset. The code requires the literal value 1 to settle automatically. This default was introduced in the earlier safety pass; connecting Gmail alone does not change it.
- The connected store's saved monitoringActive value is false. Other local stores have no connected mailbox. The profile-save bug above can cause this state, although source inspection cannot establish which past action set this particular record.
- Even when automatic confirmation is enabled, amount alone does not identify an order. The matcher requires authenticated bank evidence, a transaction reference and an order/customer association. Payments without that association go to review. This is a deliberate constraint, not evidence that polling failed.

## Verification and limits

npm test: 30 passed, 0 failed, using a temporary synthetic store with external server requests blocked. Those tests cover several important payment, authorization, stock and privacy paths, but not real Gmail/IMAP polling or successful email auto-settlement. The updated root-level test_payment_confirmation.js also uses a real local store/session and marks an order paid; it was deliberately not run. It exercises manual confirmation and simulation rather than proving mailbox monitoring.

The additional mocked checks reproduced the profile-save bug, old-receipt settlement, silent token failure and empty-inbox connection leak. A separate installed-library probe verified the incorrect IMAP body request. The remaining findings are direct source-path observations. This is a focused code review, not a complete live mailbox, browser or production audit.

Recommended sequence: prevent accidental disabling and make status truthful; unify receipt validation; repair IMAP reading/cleanup; add polling and successful auto-confirmation tests; then verify one controlled payment end to end on the local running application.
