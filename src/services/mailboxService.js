const crypto = require('crypto');
const { BANK_PRESETS, decryptSecret, encryptSecret, isAllowedImapEndpoint } = require('../config/env');
const {
  senderEmail,
  isVerifiedBankSender,
  isAuthenticatedBankEmail,
  amountInPaise,
  sanitizePublicOrder
} = require('../utils/security');
const { settleOrder, expireOrder } = require('./orderService');

function emailAutoConfirmationEnabled(seller) {
  const mode = seller?.bankingAutomation?.confirmationMode;
  return mode === 'automatic' || (mode !== 'review' && process.env.ENABLE_EMAIL_AUTO_CONFIRMATION === '1');
}

function parseBankEmail(emailPayload) {
  let text = '';
  let from = '';

  if (typeof emailPayload === 'string') {
    text = emailPayload;
  } else if (emailPayload && typeof emailPayload === 'object') {
    from = emailPayload.from || emailPayload.From || emailPayload.sender || emailPayload['from-header'] || '';
    text = [
      emailPayload.subject,
      emailPayload.text,
      emailPayload.body,
      emailPayload['stripped-text'],
      emailPayload['body-plain'],
      emailPayload.TextBody,
      emailPayload.content,
      emailPayload.html,
      emailPayload.raw
    ].filter(Boolean).join(' \n ');
  }

  const cleanText = text.replace(/<[^>]+>/g, ' ');
  let amount = null;
  let utr = null;
  let orderRef = null;
  const payerName = null;

  const amtMatches = [
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /credited\s+(?:with|by|for)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i,
    /received\s+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i,
    /payment\s+of\s+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i
  ];
  for (const regex of amtMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const clean = match[1].replace(/,/g, '');
      const parsed = parseFloat(clean);
      if (!isNaN(parsed) && parsed > 0) {
        amount = parsed;
        break;
      }
    }
  }

  const utrMatches = [
    /(?:upi\s*ref|rrn|utr|txn\s*id|ref\s*no|reference\s*no)[\s:/#-]*([0-9]{12})/i,
    /upi\/[a-z0-9_-]*\/([0-9]{12})\//i,
    /upi\/([0-9]{12})/i,
    /(?:\b)([0-9]{12})(?:\b)/
  ];
  for (const regex of utrMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      utr = match[1];
      break;
    }
  }

  const tokenMatch = cleanText.match(/\b([a-z0-9]{3}_[a-f0-9]{8,32})\b/i);
  const token = tokenMatch ? tokenMatch[1] : null;

  const refMatches = [
    /ref(?:erence)?[:\s#_-]*([a-z]{3}-[0-9]{3})/i,
    /#?([a-z]{3}-[0-9]{3})\b/i,
    /ref(?:erence)?[:\s#_-]*([a-z0-9_-]{3,12})/i
  ];
  for (const regex of refMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      orderRef = match[1].trim();
      break;
    }
  }

  const isExplicitDebit = /\b(debited|debit|spent|withdrawn|paid to|transferred to|sent to|deducted)\b/i.test(cleanText);
  const isExplicitCredit = /\b(credited|credit|received|deposited|inward|has credited|has received)\b/i.test(cleanText);
  const isCredit = isExplicitCredit && !isExplicitDebit;
  const isDebit = isExplicitDebit;

  return {
    from,
    amount,
    utr,
    orderRef,
    token,
    payerName,
    isCredit,
    isDebit,
    rawText: cleanText.substring(0, 400)
  };
}

async function bankReceiptIssue(store, order, credit) {
  if (!credit || credit.sellerId !== order.sellerId || credit.authenticationVerified !== true ||
      !/^\d{12}$/.test(credit.utr || '') || credit.allocatedOrderId) {
    return 'INVALID_OR_ALLOCATED_RECEIPT';
  }
  const existingPaid = await store.findPaidOrderByUtr(order.sellerId, credit.utr, order.id);
  if (existingPaid) return 'REFERENCE_ALREADY_ALLOCATED';
  if ((credit.orderToken && credit.orderToken.toLowerCase() !== String(order.token).toLowerCase()) ||
      (!credit.orderToken && credit.orderRef && ![order.ref, order.storeRef, order.invoiceId].some(ref => ref && String(ref).toLowerCase() === credit.orderRef.toLowerCase()))) {
    return 'ORDER_REFERENCE_MISMATCH';
  }
  const createdAt = Date.parse(order.createdAt);
  const receivedAt = Date.parse(credit.receivedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(receivedAt) ||
      receivedAt < createdAt - 5 * 60 * 1000 || receivedAt > Date.now() + 5 * 60 * 1000 ||
      amountInPaise(credit.amount) !== amountInPaise(order.payableAmount ?? order.amount)) {
    return 'AMOUNT_OR_TIME_MISMATCH';
  }
  return null;
}

function createMailboxService({
  store,
  getGoogleCredentials,
  fetchImpl = globalThis.fetch,
  getImapFlow = () => require('imapflow').ImapFlow,
  getSimpleParser = () => require('mailparser').simpleParser
}) {
  let isImapPollingActive = false;
  let backgroundTasksRunning = false;
  let bankingPollerTimeout = null;

  async function fetchWithTimeout(url, options = {}) {
    return fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(10000) });
  }

  async function processBankCreditForStore(sellerId, parsed, fromAddress, evidence = {}) {
    return store.withTransaction(async tx => {
      const seller = await tx.findSellerById(sellerId);
      if (!seller) return { success: false, reason: 'Store not found.' };
      if (!parsed.isCredit || parsed.isDebit || !isVerifiedBankSender(fromAddress, seller.bankingAutomation)) {
        return { success: false, ignored: true, reason: 'A configured incoming-bank sender and positive credit notification are required.' };
      }
      const paise = amountInPaise(parsed.amount);
      if (paise === null) return { success: false, reason: 'No valid credit amount was extracted.' };
      const utr = typeof parsed.utr === 'string' && /^\d{12}$/.test(parsed.utr) ? parsed.utr : null;
      const sourceId = evidence.sourceId ? String(evidence.sourceId).slice(0, 250) : null;
      if (utr) {
        const existingPaid = await tx.findPaidOrderByUtr(sellerId, utr);
        if (existingPaid) return { success: true, duplicate: true, message: 'This receipt has already been allocated.' };
      }
      let credit = await tx.findUnmatchedCredit({ sellerId, utr, sourceId });
      if (!credit) {
        credit = {
          id: `credit_${crypto.randomBytes(12).toString('hex')}`,
          sellerId,
          amount: paise / 100,
          amountPaise: paise,
          utr,
          sourceId,
          receivedAt: evidence.receivedAt || new Date().toISOString(),
          authenticationVerified: evidence.authenticated === true,
          orderToken: parsed.token || null,
          orderRef: parsed.orderRef || null,
          allocatedOrderId: null
        };
      } else if (credit.amountPaise !== undefined && credit.amountPaise !== paise) {
        return { success: false, reviewRequired: true, reason: 'Conflicting amounts for the same bank receipt. Owner review required.' };
      }
      if (evidence.authenticated === true) credit.authenticationVerified = true;
      if (credit.allocatedOrderId) return { success: true, duplicate: true, message: 'This receipt has already been allocated.' };

      const pending = await tx.findPendingOrders(sellerId);
      let candidates = [];
      if (parsed.token) {
        candidates = pending.filter(o => o.token && o.token.toLowerCase() === parsed.token.toLowerCase());
      } else if (parsed.orderRef) {
        candidates = pending.filter(o => [o.ref, o.storeRef, o.invoiceId].some(ref =>
          ref && String(ref).toLowerCase() === String(parsed.orderRef).toLowerCase()));
      } else if (utr) {
        candidates = pending.filter(o => o.customerReportedUtr === utr);
      }

      credit.candidateOrderTokens = pending
        .filter(o => amountInPaise(o.payableAmount ?? o.amount) === paise)
        .map(o => o.token);

      const matched = candidates.length === 1 ? candidates[0] : null;
      if (!emailAutoConfirmationEnabled(seller) || !credit.authenticationVerified || !utr || !matched) {
        credit.reviewReason = !emailAutoConfirmationEnabled(seller)
          ? 'OWNER_REVIEW_REQUIRED'
          : !credit.authenticationVerified
            ? 'EMAIL_AUTHENTICATION_REQUIRED'
            : (!utr ? 'REFERENCE_REQUIRED' : 'CUSTOMER_REFERENCE_REQUIRED');
        await tx.saveUnmatchedCredit(credit);
        return {
          success: false,
          reviewRequired: true,
          ambiguous: credit.candidateOrderTokens.length > 1,
          reason: 'Receipt saved for review. A verified sender, transaction reference, and customer/order association are required.'
        };
      }

      const receiptIssue = await bankReceiptIssue(tx, matched, credit);
      if (receiptIssue) {
        credit.reviewReason = receiptIssue;
        await tx.saveUnmatchedCredit(credit);
        return { success: false, reviewRequired: true, mismatch: true, reason: 'Payment amount or timing does not match this order.' };
      }

      if (!await settleOrder(tx, matched, {
        utr,
        method: 'Direct UPI (Authenticated Bank Alert)',
        via: 'bank_email',
        reason: 'Authenticated receipt matched order and amount'
      })) {
        credit.reviewReason = 'FULFILLMENT_REVIEW_REQUIRED';
        await tx.saveUnmatchedCredit(credit);
        return { success: false, reviewRequired: true, reason: 'Receipt requires owner review before fulfilment.' };
      }

      credit.allocatedOrderId = matched.id || matched.token;
      credit.reviewReason = null;
      await tx.saveUnmatchedCredit(credit);
      return { success: true, message: 'Payment confirmed from authenticated bank receipt.', order: sanitizePublicOrder(matched, false, seller) };
    });
  }

  async function getValidGoogleAccessToken(seller) {
    const oauth = seller.bankingAutomation?.googleOAuth;
    if (!oauth || !oauth.connected || !oauth.refreshToken) return null;

    if (oauth.accessToken && oauth.tokenExpiresAt && (oauth.tokenExpiresAt - Date.now() > 180000)) {
      return decryptSecret(oauth.accessToken);
    }

    const creds = await getGoogleCredentials();
    if (!creds.clientId || !creds.clientSecret) return null;

    const plainRefreshToken = decryptSecret(oauth.refreshToken);
    if (!plainRefreshToken) return null;

    try {
      const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: plainRefreshToken,
          grant_type: 'refresh_token'
        })
      });
      const data = await res.json();
      if (res.ok && data.access_token) {
        oauth.accessToken = encryptSecret(data.access_token);
        if (data.refresh_token) oauth.refreshToken = encryptSecret(data.refresh_token);
        oauth.tokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
        await store.saveSeller(seller);
        return data.access_token;
      }
      console.error(`[Google OAuth] Token refresh failed (${res.status}).`);
      return null;
    } catch (err) {
      console.error(`[Google OAuth - ${seller.brandName}] Token refresh exception:`, err.message);
      return null;
    }
  }

  async function pollStoreGmail(seller) {
    const auto = seller.bankingAutomation;
    if (!auto || !auto.monitoringActive || !auto.googleOAuth?.connected) return;
    auto.lastCheckedAt = new Date().toISOString();
    let accessToken;
    try { accessToken = await getValidGoogleAccessToken(seller); } catch (_) { accessToken = null; }
    if (!accessToken) {
      auto.lastError = 'Gmail access could not be refreshed. Check platform Google configuration and reconnect your Gmail account.';
      await store.saveSeller(seller);
      return;
    }

    const rawSender = auto.verifiedSenderEmail || BANK_PRESETS[auto.bankCode]?.verifiedSender || '';
    let senders = rawSender.split(/[,;]+/).map(value => value.trim()).filter(Boolean);
    let preset = BANK_PRESETS[auto.bankCode];
    if (!preset && auto.bankName) {
      const bName = String(auto.bankName).toLowerCase();
      preset = Object.values(BANK_PRESETS).find(p => p.name.toLowerCase().includes(bName) || bName.includes(p.name.toLowerCase()));
    }
    if (preset && preset.verifiedSender && !senders.includes(preset.verifiedSender)) {
      senders.push(preset.verifiedSender);
    }
    if (!senders.length) {
      senders = Object.values(BANK_PRESETS).map(p => p.verifiedSender).filter(Boolean);
    }

    const inspected = new Set(Array.isArray(auto.inspectedGmailMessageIds) ? auto.inspectedGmailMessageIds : []);
    const fromClauses = senders.map(s => (s.includes('@') ? `from:${s}` : `from:*@${s}`)).join(' OR ');
    const query = `newer_than:7d (${fromClauses})`;
    const auth = { Authorization: `Bearer ${accessToken}` };
    let failed = false;

    try {
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ q: query, maxResults: '100' });
        if (auto.gmailPageToken) params.set('pageToken', auto.gmailPageToken);
        const listResponse = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: auth });
        if (!listResponse.ok) {
          auto.gmailPageToken = null;
          throw new Error(`Gmail list request failed (${listResponse.status}).`);
        }
        const list = await listResponse.json();
        for (const message of list.messages || []) {
          if (inspected.has(message.id)) continue;
          try {
            const response = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`, { headers: auth });
            if (!response.ok) { failed = true; continue; }
            const data = await response.json();
            const headers = Array.isArray(data.payload?.headers) ? data.payload.headers : [];
            const from = headers.find(h => String(h.name).toLowerCase() === 'from')?.value || '';
            const subject = headers.find(h => String(h.name).toLowerCase() === 'subject')?.value || '';
            if (isVerifiedBankSender(from, auto)) {
              const bodies = [];
              const extractBody = part => {
                if (!part) return;
                if (part.body?.data && ['text/plain', 'text/html'].includes(part.mimeType)) {
                  bodies.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
                }
                (part.parts || []).forEach(extractBody);
              };
              extractBody(data.payload);
              const receivedAt = Number(data.internalDate);
              const parsed = parseBankEmail({ from, subject, text: bodies.join('\n') });
              const result = await processBankCreditForStore(seller.id, parsed, from, {
                authenticated: isAuthenticatedBankEmail(headers, from),
                sourceId: `gmail:${message.id}`,
                receivedAt: Number.isFinite(receivedAt) ? new Date(receivedAt).toISOString() : new Date().toISOString()
              });
              if (result.success && !result.duplicate) auto.lastMatchedAt = new Date().toISOString();
            }
            inspected.add(message.id);
          } catch (_) {
            failed = true;
          }
        }
        auto.gmailPageToken = list.nextPageToken || null;
        auto.inspectedGmailMessageIds = [...inspected].slice(-5000);
        await store.saveSeller(seller);
        if (!auto.gmailPageToken) break;
      }
      if (failed) auto.gmailPageToken = null;
      if (!failed) auto.lastSuccessfulCheckAt = new Date().toISOString();
      auto.lastError = failed ? 'Some bank messages could not be read. Retrying automatically.' : null;
    } catch (error) {
      auto.lastError = error.message;
    }
    auto.lastCheckedAt = new Date().toISOString();
    await store.saveSeller(seller);
  }

  async function checkStoreInbox(seller) {
    const auto = seller.bankingAutomation;
    if (!auto || !auto.monitoringActive) return;
    auto.lastCheckedAt = new Date().toISOString();
    let client;
    try {
      if (!isAllowedImapEndpoint(auto.imapHost || 'imap.gmail.com', auto.imapPort || 993)) {
        throw new Error('This IMAP provider is not approved.');
      }
      const cleanPass = (decryptSecret(auto.imapAppPassword) || '').replace(/\s+/g, '').trim();
      if (!auto.imapUser || !cleanPass) {
        throw new Error('Configure the mailbox address and app password, or connect Gmail.');
      }
      const ImapFlow = getImapFlow();
      const simpleParser = getSimpleParser();
      client = new ImapFlow({
        host: auto.imapHost || 'imap.gmail.com',
        port: Number(auto.imapPort || 993),
        secure: true,
        auth: { user: auto.imapUser.trim(), pass: cleanPass },
        logger: false,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000
      });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const validity = String(client.mailbox.uidValidity);
        const inspected = new Set(auto.imapUidValidity === validity && Array.isArray(auto.inspectedImapUids) ? auto.inspectedImapUids : []);
        const uids = await client.search({ since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, { uid: true });
        let failed = false;
        for (const uid of (uids || []).filter(u => !inspected.has(String(u))).slice(0, 200)) {
          try {
            const metadata = await client.fetchOne(uid, { internalDate: true }, { uid: true });
            const download = await client.download(uid, undefined, { uid: true });
            if (!download?.content) { failed = true; continue; }
            const email = await simpleParser(download.content);
            const from = email.from?.value?.[0]?.address || email.from?.text || '';
            if (isVerifiedBankSender(from, auto)) {
              const authValue = email.headers?.get('authentication-results');
              const headers = (Array.isArray(authValue) ? authValue : [authValue]).map(value => ({
                name: 'authentication-results',
                value: String(value || '')
              }));
              const parsed = parseBankEmail({ subject: email.subject, text: email.text, html: email.html, from });
              const result = await processBankCreditForStore(seller.id, parsed, from, {
                authenticated: (auto.imapHost || 'imap.gmail.com') === 'imap.gmail.com' && isAuthenticatedBankEmail(headers, from),
                sourceId: `imap:${auto.imapUser}:${validity}:${uid}`,
                receivedAt: metadata?.internalDate ? new Date(metadata.internalDate).toISOString() : 'unknown'
              });
              if (result.success && !result.duplicate) auto.lastMatchedAt = new Date().toISOString();
            }
            inspected.add(String(uid));
          } catch (_) {
            failed = true;
          }
        }
        auto.imapUidValidity = validity;
        auto.inspectedImapUids = [...inspected].slice(-5000);
        auto.lastError = failed ? 'Some bank messages could not be read. Retrying automatically.' : null;
        if (!failed) auto.lastSuccessfulCheckAt = new Date().toISOString();
      } finally {
        lock.release();
      }
    } catch (_) {
      auto.lastError = 'Mailbox check failed. Verify the provider, mailbox address and app password, then retry.';
    } finally {
      if (client) {
        try { await client.logout(); } catch (_) { client.close(); }
      }
      await store.saveSeller(seller);
    }
  }

  async function triggerBankingPoller() {
    if (process.env.DISABLE_BANK_POLLING === '1' || !backgroundTasksRunning || isImapPollingActive) return;
    isImapPollingActive = true;
    try {
      const sellers = await store.listSellers();
      for (const seller of sellers) {
        if (!seller.bankingAutomation) continue;
        if (seller.bankingAutomation.monitoringActive && seller.bankingAutomation.googleOAuth?.connected) {
          await pollStoreGmail(seller);
          if (seller.bankingAutomation.lastError && seller.bankingAutomation.imapUser && seller.bankingAutomation.imapAppPassword) {
            await checkStoreInbox(seller);
          }
        } else if (seller.bankingAutomation.monitoringActive && seller.bankingAutomation.imapUser && seller.bankingAutomation.imapAppPassword) {
          await checkStoreInbox(seller);
        }
      }
    } catch (e) {
      console.error('[Banking Poller Error]:', e.message);
    } finally {
      isImapPollingActive = false;
    }
  }

  async function scheduleAdaptiveBankingPoller() {
    if (!backgroundTasksRunning || process.env.DISABLE_BANK_POLLING === '1') return;
    if (bankingPollerTimeout) {
      clearTimeout(bankingPollerTimeout);
      bankingPollerTimeout = null;
    }
    try {
      await triggerBankingPoller();
    } catch (err) {
      console.error('[Adaptive Poller Error]:', err.message);
    }
    const hasPending = await store.hasPendingOrders();
    const nextDelay = hasPending ? 3500 : 12000;
    if (backgroundTasksRunning) bankingPollerTimeout = setTimeout(scheduleAdaptiveBankingPoller, nextDelay);
  }

  function startPoller() {
    if (process.env.DISABLE_BANK_POLLING === '1') return;
    backgroundTasksRunning = true;
    bankingPollerTimeout = setTimeout(scheduleAdaptiveBankingPoller, 1500);
  }

  function stopPoller() {
    backgroundTasksRunning = false;
    if (bankingPollerTimeout) clearTimeout(bankingPollerTimeout);
    bankingPollerTimeout = null;
  }

  return {
    parseBankEmail,
    emailAutoConfirmationEnabled,
    bankReceiptIssue: (order, credit) => bankReceiptIssue(store, order, credit),
    processBankCreditForStore,
    getValidGoogleAccessToken,
    pollStoreGmail,
    checkStoreInbox,
    triggerBankingPoller,
    scheduleAdaptiveBankingPoller,
    startPoller,
    stopPoller,
    setBackgroundRunning(val) { backgroundTasksRunning = val; },
    isPollingActive: () => isImapPollingActive
  };
}

module.exports = {
  emailAutoConfirmationEnabled,
  parseBankEmail,
  bankReceiptIssue,
  createMailboxService,
  expireOrder
};

