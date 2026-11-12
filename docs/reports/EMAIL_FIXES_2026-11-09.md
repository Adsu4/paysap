# Email monitoring fixes — 9 November 2026

All seven findings in PAYSAP_REVIEW_2026-11-08.md have code fixes and regression coverage.

| Finding | Change |
|---|---|
| Profile saves stop monitoring | Ordinary profile saves no longer include monitoring or confirmation-mode fields. Separate owner-only email controls save these explicitly. |
| Old receipts can settle newer orders through UTR submission | Both automatic settlement paths use the same receipt validation: merchant, authentication, transaction reference, allocation, explicit order association when supplied, amount and time. Invalid/missing receipt dates stay in review. |
| Wrong IMAP download | Requests the complete raw message with explicit UID addressing. Parses the stream, and uses the provider's internal receipt date instead of processing time. |
| False healthy status | Status distinguishes server-disabled polling, paused monitoring, no connection, failed checks, waiting for first success, stale checks and recent success. Confirmation mode is shown separately. Status is refreshed when settings are loaded/reloaded or email settings are saved. |
| Silent OAuth failure | Failed refreshes produce a safe actionable error and attempted-check timestamp. Successful checks record a separate timestamp. Configured IMAP is attempted when Gmail polling fails. |
| Read messages skipped | Searches a recent seven-day window irrespective of read status; tracks processed UIDs per mailbox UIDVALIDITY. Processes at most 200 previously unseen messages per pass and does not mark customer mail read. |
| IMAP connection leak | Lock and client cleanup run on empty inboxes, failures and success. Transport timeouts bound connection waits. |

## Owner controls

In Settings → UPI & Banking → Email monitoring:

1. Enable **Check bank emails automatically**.
2. Choose **Confirm verified matches** for automatic confirmation, or **Save for owner review**.
3. Click **Save email settings**.

The store's explicit confirmation choice takes precedence over the legacy ENABLE_EMAIL_AUTO_CONFIRMATION default. Stores with no explicit choice retain the existing environment default; the provided environment template defaults to review. DISABLE_BANK_POLLING=1 remains a server-level switch that stops mailbox checks and is clearly reported in Settings. Restart a running local Node process to load changed server code.

Automatic mode continues to require authenticated evidence, a valid reference and a matching order/amount/time. Amount alone cannot identify who paid. Receipts without a reliable order association remain in review until the customer supplies the matching reference or the owner verifies the payment.

## Verification

- 46 tests pass: existing authorization, payments, stock, privacy and themes; additional mocked mailbox and synthetic API integration regressions.
- Gmail message parsing through the real matching code confirms an authenticated match and deduplicates it.
- Real HTTP integration with isolated synthetic records verifies fresh-email auto-confirmation, stock decrement exactly once, old-receipt rejection on both paths, and receipt-before-reference confirmation.
- IMAP tests cover raw source/UID request shape, read-independent search, UIDVALIDITY changes, retryable failures and connection cleanup.
- UI save-code regression confirms ordinary profile requests omit email controls.
- Browser verification confirmed independent control saving, persistence after profile saving/reloading, and 390px mobile settings without horizontal overflow.
- CSS build and JavaScript syntax/diff checks completed.

Testing used disposable records and blocked external server requests. No real bank email was accessed and no real payment was confirmed. Existing merchant data and credentials were not changed. The disposable demo deliberately reports mailbox checks disabled on its server.

Screenshot: artifacts/email-fixes/monitoring-mobile.png.

Live mailbox/provider-specific verification remains necessary after restarting the normal local app and enabling the owner's chosen email settings.
