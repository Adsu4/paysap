// Execute the actual mailbox service with injected transports, never a live inbox or data directory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { JsonStore } = require('../src/storage/jsonStore');
const {
  createMailboxService,
  emailAutoConfirmationEnabled,
  bankReceiptIssue
} = require('../src/services/mailboxService');
const status = require('../public/js/bank-status');

function makeStore({ sellers = [], orders = [], unmatchedCredits = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paysap-mailbox-'));
  const store = new JsonStore(dir);
  store.sellers = sellers;
  store.orders = orders;
  store.unmatchedCredits = unmatchedCredits;
  store._save = () => {};
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const seller = () => ({
  id: 'merchant',
  bankingAutomation: {
    monitoringActive: true,
    confirmationMode: 'automatic',
    verifiedSenderEmail: 'alerts@example.test',
    googleOAuth: { connected: true },
    imapUser: 'test@example.invalid',
    imapAppPassword: 'synthetic'
  }
});

const order = () => ({
  id: 'ord_1',
  sellerId: 'merchant',
  token: 'abc_1234567890abcdef',
  ref: 'ABC-001',
  storeRef: 'ABC-001',
  status: 'PENDING',
  amount: 100,
  payableAmount: 100,
  createdAt: new Date().toISOString()
});

const headers = [
  { name: 'from', value: 'alerts@example.test' },
  { name: 'authentication-results', value: 'mx.google.com; dmarc=pass header.from=example.test; dkim=pass' }
];

test('Gmail polling parses an authenticated message, settles exactly once and deduplicates', async () => {
  const merchant = seller();
  const purchase = order();
  let reads = 0;
  const { store, cleanup } = makeStore({ sellers: [merchant], orders: [purchase] });
  try {
    const svc = createMailboxService({
      store,
      getGoogleCredentials: async () => ({ clientId: 'id', clientSecret: 'sec' }),
      fetchImpl: async url => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
        }
        return {
          ok: true,
          json: async () => url.includes('format=full')
            ? (reads++, {
              internalDate: String(Date.now()),
              payload: {
                mimeType: 'text/plain',
                headers,
                body: { data: Buffer.from(`INR 100 credited UTR 123456789012 REF ${purchase.token}`).toString('base64url') }
              }
            })
            : { messages: [{ id: 'message-one' }] }
        };
      }
    });
    merchant.bankingAutomation.googleOAuth.refreshToken = 'refresh';
    await svc.pollStoreGmail(merchant);
    await svc.pollStoreGmail(merchant);
    assert.equal(purchase.status, 'PAID');
    assert.equal(reads, 1);
    assert.equal(store.unmatchedCredits.length, 1);
    assert.equal(store.unmatchedCredits[0].allocatedOrderId, purchase.id);
    assert.ok(merchant.bankingAutomation.lastSuccessfulCheckAt);
  } finally {
    cleanup();
  }
});

test('Gmail refresh failure persists an actionable error and attempted check', async () => {
  const merchant = seller();
  const { store, cleanup } = makeStore({ sellers: [merchant] });
  try {
    const svc = createMailboxService({
      store,
      getGoogleCredentials: async () => ({ clientId: 'id', clientSecret: 'sec' }),
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    });
    merchant.bankingAutomation.googleOAuth.refreshToken = 'bad';
    await svc.pollStoreGmail(merchant);
    assert.match(merchant.bankingAutomation.lastError, /reconnect/);
    assert.ok(merchant.bankingAutomation.lastCheckedAt);
    assert.equal(merchant.bankingAutomation.lastSuccessfulCheckAt, undefined);
  } finally {
    cleanup();
  }
});

test('Gmail message failures remain eligible for retry', async () => {
  const merchant = seller();
  merchant.bankingAutomation.googleOAuth.accessToken = 'tok';
  merchant.bankingAutomation.googleOAuth.refreshToken = 'ref';
  merchant.bankingAutomation.googleOAuth.tokenExpiresAt = Date.now() + 3600_000;
  const { store, cleanup } = makeStore({ sellers: [merchant] });
  try {
    const svc = createMailboxService({
      store,
      getGoogleCredentials: async () => ({ clientId: 'id', clientSecret: 'sec' }),
      fetchImpl: async url => ({ ok: !url.includes('format=full'), json: async () => ({ messages: [{ id: 'retry-me' }] }) })
    });
    await svc.pollStoreGmail(merchant);
    assert.equal(merchant.bankingAutomation.inspectedGmailMessageIds.length, 0);
    assert.match(merchant.bankingAutomation.lastError, /Retrying/);
  } finally {
    cleanup();
  }
});

test('shared receipt validation rejects old, future, unallocated cross-order and mismatched receipts', async () => {
  const purchase = order();
  const { store, cleanup } = makeStore({ orders: [purchase] });
  try {
    const receipt = {
      sellerId: 'merchant',
      utr: '123456789012',
      authenticationVerified: true,
      amount: 100,
      receivedAt: new Date().toISOString()
    };
    assert.equal(await bankReceiptIssue(store, purchase, receipt), null);
    for (const change of [
      { receivedAt: '2020-01-01' },
      { receivedAt: 'invalid' },
      { receivedAt: new Date(Date.now() + 86400000).toISOString() },
      { amount: 101 },
      { sellerId: 'other' },
      { allocatedOrderId: 'other' },
      { orderToken: 'other' },
      { orderRef: 'ABC-002' },
      { authenticationVerified: false }
    ]) {
      assert.ok(await bankReceiptIssue(store, purchase, { ...receipt, ...change }), JSON.stringify(change));
    }
  } finally {
    cleanup();
  }
});

test('owner confirmation choice overrides legacy environment defaults', () => {
  const prev = process.env.ENABLE_EMAIL_AUTO_CONFIRMATION;
  try {
    process.env.ENABLE_EMAIL_AUTO_CONFIRMATION = '1';
    assert.equal(emailAutoConfirmationEnabled({ bankingAutomation: { confirmationMode: 'review' } }), false);
    process.env.ENABLE_EMAIL_AUTO_CONFIRMATION = '0';
    assert.equal(emailAutoConfirmationEnabled(seller()), true);
  } finally {
    if (prev === undefined) delete process.env.ENABLE_EMAIL_AUTO_CONFIRMATION;
    else process.env.ENABLE_EMAIL_AUTO_CONFIRMATION = prev;
  }
});

function imapHarness(uids, fail = false) {
  const calls = { logout: 0, release: 0, download: [], search: null };
  const merchant = seller();
  merchant.bankingAutomation.googleOAuth.connected = false;
  const { store, cleanup } = makeStore({ sellers: [merchant] });
  const svc = createMailboxService({
    store,
    getGoogleCredentials: async () => ({ clientId: '', clientSecret: '' }),
    getImapFlow: () => class {
      constructor() { this.mailbox = { uidValidity: 123 }; }
      async connect() {}
      async getMailboxLock() { return { release() { calls.release++; } }; }
      async search(query, options) { calls.search = { query, options }; return uids; }
      async fetchOne() { return { internalDate: new Date() }; }
      async download(...args) {
        calls.download.push(args);
        if (fail) throw Error('Transport failure');
        return { content: 'synthetic-stream' };
      }
      async logout() { calls.logout++; }
      close() {}
    },
    getSimpleParser: () => async () => ({ from: { value: [{ address: 'unrelated@example.test' }] } })
  });
  return { svc, calls, merchant, cleanup };
}

test('empty IMAP inbox always releases lock and logs out', async () => {
  const { svc, calls, merchant, cleanup } = imapHarness([]);
  try {
    await svc.checkStoreInbox(merchant);
    assert.equal(calls.release, 1);
    assert.equal(calls.logout, 1);
    assert.ok(merchant.bankingAutomation.lastSuccessfulCheckAt);
  } finally {
    cleanup();
  }
});

test('IMAP includes read messages, downloads raw source by UID and deduplicates', async () => {
  const { svc, calls, merchant, cleanup } = imapHarness([42]);
  try {
    await svc.checkStoreInbox(merchant);
    await svc.checkStoreInbox(merchant);
    assert.equal(calls.search.query.seen, undefined);
    assert.ok(calls.search.query.since);
    assert.equal(calls.search.options.uid, true);
    assert.equal(calls.download.length, 1);
    assert.equal(calls.download[0][0], 42);
    assert.equal(calls.download[0][1], undefined);
    assert.equal(calls.download[0][2].uid, true);
    assert.equal(calls.logout, 2);
  } finally {
    cleanup();
  }
});

test('IMAP parsing/transport failure is visible, retries and closes connection', async () => {
  const { svc, calls, merchant, cleanup } = imapHarness([42], true);
  try {
    await svc.checkStoreInbox(merchant);
    await svc.checkStoreInbox(merchant);
    assert.equal(calls.download.length, 2);
    assert.equal(calls.logout, 2);
    assert.match(merchant.bankingAutomation.lastError, /Retrying/);
    assert.equal(merchant.bankingAutomation.lastSuccessfulCheckAt, undefined);
  } finally {
    cleanup();
  }
});

test('mailbox UID validity changes invalidate the processed-message cursor', async () => {
  const { svc, calls, merchant, cleanup } = imapHarness([42]);
  try {
    merchant.bankingAutomation.imapUidValidity = 'old';
    merchant.bankingAutomation.inspectedImapUids = ['42'];
    await svc.checkStoreInbox(merchant);
    assert.equal(calls.download.length, 1);
  } finally {
    cleanup();
  }
});

test('bank status distinguishes paused, failed, stale and healthy monitoring', () => {
  const active = {
    monitoringActive: true,
    googleOAuth: { connected: true },
    lastSuccessfulCheckAt: new Date().toISOString(),
    confirmationMode: 'automatic'
  };
  assert.equal(status.describe(active).tone, 'good');
  assert.match(status.describe({ ...active, monitoringActive: false }).title, /paused/);
  assert.equal(status.describe({ ...active, lastError: 'Reconnect Gmail' }).tone, 'error');
  assert.match(status.describe({ ...active, lastSuccessfulCheckAt: '2020-01-01' }).title, /not updated/);
  assert.match(status.describe({ ...active, pollingEnabled: false }).title, /disabled/);
  assert.match(status.describe({ ...active, confirmationMode: 'review' }).detail, /owner review/);
});

test('ordinary profile saves omit monitoring and confirmation controls even when they are visible', async () => {
  const source = fs.readFileSync(require.resolve('../public/js/seller.js'), 'utf8');
  const start = source.indexOf('async function handleSaveStoreSettings()');
  const end = source.indexOf('// Direct Bank Credit Email Automation', start);
  const body = source.slice(start, end);
  const fields = {
    setBrandName: { value: 'Synthetic' },
    setUpiId: { value: 'test@invalid' },
    setBankMonitoringActive: { checked: false },
    setBankConfirmationMode: { value: 'review' },
    btnSaveSettings: { innerHTML: 'Save', disabled: false }
  };
  let sent;
  const ctx = {
    document: { getElementById: id => fields[id] || null },
    currentSeller: { themeId: 'lavender' },
    getAuthHeaders: () => ({}),
    showToast() {},
    console,
    fetch: async (url, options) => {
      sent = JSON.parse(options.body);
      return { ok: false, json: async () => ({ error: 'mock' }) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  await ctx.handleSaveStoreSettings();
  assert.equal(Object.hasOwn(sent.bankingAutomation, 'monitoringActive'), false);
  assert.equal(Object.hasOwn(sent.bankingAutomation, 'confirmationMode'), false);
});

test('OAuth failure uses configured IMAP fallback and always clears the poll lock', async () => {
  const merchant = seller();
  const { store, cleanup } = makeStore({ sellers: [merchant] });
  let fallback = 0;
  try {
    const svc = createMailboxService({
      store,
      getGoogleCredentials: async () => ({ clientId: 'id', clientSecret: 'sec' }),
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      getImapFlow: () => class {
        constructor() { this.mailbox = { uidValidity: 1 }; fallback++; }
        async connect() {}
        async getMailboxLock() { return { release() {} }; }
        async search() { return []; }
        async logout() {}
        close() {}
      }
    });
    merchant.bankingAutomation.googleOAuth.refreshToken = 'bad';
    svc.setBackgroundRunning(true);
    await svc.triggerBankingPoller();
    assert.equal(fallback, 1);
    assert.equal(svc.isPollingActive(), false);
  } finally {
    cleanup();
  }
});
