// These tests own their server and temporary synthetic records. Never target a running store.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
let tempDir, child, baseUrl, startupOutput = '';
let alpha, beta, staff, staffId, webhookSecret;
const paymentUtr = '100000000001';

async function request(route, { method = 'GET', token, body, session, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'x-order-session': session } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

async function createOrder(owner = alpha, overrides = {}) {
  const result = await request('/api/orders', {
    method: 'POST', token: owner.token,
    body: {
      customerName: 'Synthetic Customer', customerPhone: '9000000001',
      itemDescription: 'Test scarf', amount: 499.5,
      internalNotes: 'Private synthetic staff note', ...overrides
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.ok(result.data.order.token);
  return result.data.order;
}

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paysap-regression-'));
  const dataDir = path.join(tempDir, 'data');
  await fs.mkdir(dataDir);
  // Explicitly empty fixtures: no examples, real credentials or active mailboxes.
  for (const [name, value] of Object.entries({ sellers: [], orders: [], products: [], sessions: {}, unmatched_credits: [] })) {
    await fs.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(value));
  }
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
    DATA_DIR: dataDir, DISABLE_BANK_POLLING: '1', APP_URL: 'https://paysap.test',
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    WEBHOOK_SHARED_SECRET: webhookSecret = crypto.randomBytes(32).toString('hex'), ENABLE_EMAIL_AUTO_CONFIRMATION: '0'
  });
  child = spawn(process.execPath, ['--require', path.join(__dirname, 'no-external-network.cjs'), path.join(root, 'server.js')], {
    cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { startupOutput = (startupOutput + chunk).slice(-12000); });
  child.on('error', err => { startupOutput += err.message; });
  const deadline = Date.now() + 30000;
  let lastStartupErr = '';
  while (true) {
    if (child.exitCode !== null) throw new Error(`Isolated server exited (${child.exitCode}): ${startupOutput}`);
    try {
      const ready = await request('/healthz');
      if (ready.status === 200) break;
      lastStartupErr = `status=${ready.status}`;
    } catch (err) {
      lastStartupErr = err && err.message ? err.message : String(err);
    }
    if (Date.now() > deadline) throw new Error(`Isolated server did not start (${lastStartupErr}): ${startupOutput}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function register(prefix) {
    const result = await request('/api/auth/register', {
      method: 'POST', body: {
        email: `${prefix}@example.test`, password: 'Synthetic-test-password-2026!',
        brandName: `${prefix} Test Store`, ownerName: 'Test Owner', phone: '9000000000',
        upiId: `${prefix}@test`, salesmen: [{ name: 'Test Staff', pin: '4826' }]
      }
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  alpha = await register('Alpha');
  beta = await register('Beta');
  staffId = alpha.seller.salesmen[0].id;
  const login = await request('/api/auth/salesman-login', {
    method: 'POST', body: { storeId: alpha.seller.id, salesmanId: staffId, pin: '4826' }
  });
  assert.equal(login.status, 200);
  staff = login.data;
}, { timeout: 35000 });

after(async () => {
  if (child && child.exitCode === null) {
    const closed = once(child, 'exit');
    child.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
  if (tempDir) {
    const resolved = path.resolve(tempDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'Cleanup must stay inside the temp directory');
    assert.ok(path.basename(resolved).startsWith('paysap-regression-'), 'Cleanup must target this test fixture');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

test('seller authentication and staff permissions keep secrets owner-only', async () => {
  assert.equal((await request('/api/orders')).status, 401);
  const me = await request('/api/auth/me', { token: staff.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.seller.passwordHash, undefined);
  assert.equal(me.data.seller.bankingAutomation, undefined);
  assert.equal(me.data.seller.salesmen, undefined);
  assert.equal((await request('/api/store/settings', { token: staff.token })).status, 403);
  assert.equal((await request('/api/admin/oauth-config', { token: alpha.token })).status, 403);
});

test('exact price is preserved and token checkout excludes private fields', async () => {
  const first = await createOrder();
  const second = await createOrder();
  assert.equal(first.payableAmount, 499.5);
  assert.equal(second.payableAmount, 499.5);
  assert.notEqual(first.token, second.token);
  const checkout = await request(`/api/orders/${first.token}`);
  assert.equal(checkout.status, 200);
  for (const field of ['internalNotes', 'customerSessionKey', 'sellerId', 'customerReportedUtr']) {
    assert.equal(checkout.data.order[field], undefined, `${field} leaked to public checkout`);
  }
  assert.notEqual(checkout.data.order.customerPhone, '9000000001');
  assert.ok([403, 404].includes((await request(`/api/orders/${first.ref}`)).status));
});

test('other merchants cannot read, settle, or dispatch a tenant order', async () => {
  const order = await createOrder();
  const list = await request('/api/orders', { token: beta.token });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.data).includes(order.token));
  for (const action of ['mark-paid', 'dispatch']) {
    const result = await request(`/api/orders/${order.token}/${action}`, {
      method: 'POST', token: beta.token, body: { status: 'DISPATCHED', paymentMethod: 'Cash' }
    });
    assert.ok([403, 404].includes(result.status), `${action} allowed another merchant`);
  }
});

test('unverified customer UTR is a report and never grants paid status or reduces stock', async () => {
  const product = await request('/api/products', {
    method: 'POST', token: alpha.token,
    body: { name: 'Inventory test scarf', sku: 'TEST-STOCK', price: 850, stock: 2 }
  });
  assert.equal(product.status, 201);
  const order = await createOrder(alpha, { itemDescription: 'Inventory test scarf', sku: 'TEST-STOCK', amount: 850 });
  const report = await request(`/api/orders/${order.token}/utr`, { method: 'POST', body: { utr: paymentUtr } });
  assert.equal(report.status, 202);
  assert.equal(report.data.verified, false);
  assert.equal(report.data.order.status, 'PENDING');
  assert.equal(report.data.order.paymentStatus, 'AWAITING_CONFIRMATION');
  const catalog = await request(`/api/products/${product.data.product.id}`, { token: alpha.token });
  assert.equal(catalog.data.product.stock, 2);
  assert.equal((await request(`/api/orders/${order.token}/mark-paid`, { method: 'POST', token: staff.token, body: {} })).status, 403);
  const settle = await request(`/api/orders/${order.token}/mark-paid`, {
    method: 'POST', token: alpha.token, body: { paymentMethod: 'Cash', utr: paymentUtr }
  });
  assert.equal(settle.status, 200, JSON.stringify(settle.data));
  assert.equal(settle.data.order.status, 'PAID');
  const repeat = await request(`/api/orders/${order.token}/mark-paid`, { method: 'POST', token: alpha.token, body: {} });
  assert.equal(repeat.status, 200);
  assert.equal((await request(`/api/products/${product.data.product.id}`, { token: alpha.token })).data.product.stock, 1);
});

test('manual settlements reject reuse of a real UTR on another order', async () => {
  const order = await createOrder();
  const duplicate = await request(`/api/orders/${order.token}/mark-paid`, {
    method: 'POST', token: alpha.token, body: { utr: paymentUtr, paymentMethod: 'Direct UPI' }
  });
  assert.ok([400, 409].includes(duplicate.status));
  assert.equal((await request(`/api/orders/${order.token}`, { token: alpha.token })).data.order.status, 'PENDING');
});

test('address editing needs its returned customer session and freezes after dispatch', async () => {
  const order = await createOrder();
  const address = { fullName: 'Test Recipient', phone: '9000000001', flat: 'Synthetic House 10', street: 'Test Road', pincode: '560038', city: 'Bengaluru', state: 'Karnataka' };
  const saved = await request(`/api/orders/${order.token}/address`, { method: 'POST', body: address });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const session = saved.data.customerSessionKey;
  assert.ok(session, 'First address save must return the editing session');
  const outsider = await request(`/api/orders/${order.token}/address`, { method: 'POST', body: { ...address, flat: 'Attacker replacement' } });
  assert.ok([401, 403, 409].includes(outsider.status));
  const publicView = await request(`/api/orders/${order.token}`);
  assert.ok(!JSON.stringify(publicView.data).includes(address.flat));
  const edited = await request(`/api/orders/${order.token}/address`, { method: 'POST', session, body: { ...address, flat: 'Synthetic House 11' } });
  assert.equal(edited.status, 200);
  await request(`/api/orders/${order.token}/mark-paid`, { method: 'POST', token: alpha.token, body: { paymentMethod: 'Cash' } });
  const dispatched = await request(`/api/orders/${order.token}/dispatch`, { method: 'POST', token: alpha.token, body: { status: 'DISPATCHED', trackingNumber: 'TEST123' } });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.data));
  const frozen = await request(`/api/orders/${order.token}/address`, { method: 'POST', session, body: address });
  assert.equal(frozen.status, 409);
});

test('dispatch rejects unpaid shipping, invalid states and backwards delivery', async () => {
  const order = await createOrder();
  await request(`/api/orders/${order.token}/address`, {method: 'POST', body: {fullName: 'Test Recipient', phone: '9000000001', flat: 'Test House', street: 'Test Road', pincode: '560038', city: 'Bengaluru', state: 'Karnataka'}});
  for (const status of ['DISPATCHED', 'NOT_A_STATUS']) {
    const result = await request(`/api/orders/${order.token}/dispatch`, { method: 'POST', token: alpha.token, body: { status } });
    assert.ok([400, 409].includes(result.status));
  }
  await request(`/api/orders/${order.token}/mark-paid`, { method: 'POST', token: alpha.token, body: { paymentMethod: 'Cash' } });
  assert.equal((await request(`/api/orders/${order.token}/dispatch`, {method: 'POST', token: alpha.token, body: {status: 'DISPATCHED'}})).status, 409, 'Shipping requires a tracking number');
  assert.equal((await request(`/api/orders/${order.token}/dispatch`, { method: 'POST', token: alpha.token, body: { status: 'DISPATCHED', trackingNumber: 'TEST456' } })).status, 200);
  assert.equal((await request(`/api/orders/${order.token}/dispatch`, { method: 'POST', token: alpha.token, body: { status: 'DELIVERED' } })).status, 200);
  const backwards = await request(`/api/orders/${order.token}/dispatch`, { method: 'POST', token: alpha.token, body: { status: 'PACKING' } });
  assert.equal(backwards.status, 409);
});

test('removed simulation and unauthenticated inbound bank events cannot settle orders', async () => {
  const order = await createOrder();
  const sim = await request('/api/webhook/simulate-bank-email', { method: 'POST', token: alpha.token, body: { token: order.token, amount: order.amount } });
  assert.equal(sim.status, 404);
  const webhook = await request('/api/webhook/bank-email', { method: 'POST', body: { from: 'alerts@hdfcbank.net', text: `INR 499.50 credited UTR 100000000099 REF ${order.token}` } });
  assert.equal(webhook.status, 401);
  const ingest = await request('/api/seller/test-ingest-email', { method: 'POST', token: alpha.token, body: { text: 'INR 499.50 credited' } });
  assert.equal(ingest.status, 403);
  assert.equal((await request(`/api/orders/${order.token}`, { token: alpha.token })).data.order.status, 'PENDING');
});

test('removing staff revokes their existing access immediately', async () => {
  assert.equal((await request(`/api/store/salesmen/${staffId}`, { method: 'DELETE', token: alpha.token })).status, 200);
  const revoked = await request('/api/auth/me', { token: staff.token });
  assert.equal(revoked.data.authenticated, false);
  assert.equal((await request('/api/orders', {token: staff.token})).status, 401);
});

test('parallel order creation yields unique tokens and store references', async () => {
  const orders = await Promise.all(Array.from({ length: 12 }, (_, index) => createOrder(beta, { itemDescription: `Concurrent synthetic item ${index}` })));
  assert.equal(new Set(orders.map(order => order.token)).size, orders.length);
  assert.equal(new Set(orders.map(order => order.ref)).size, orders.length);
  assert.equal(new Set(orders.map(order => order.invoiceId)).size, orders.length);
});


test('idempotent creation retries return the same order and changed payloads conflict', async () => {
  const body = {customerName: 'Retry Customer', customerPhone: '9000000001', itemDescription: 'Idempotent test item', amount: '1299.25'};
  const headers = {'Idempotency-Key': 'synthetic-request-001'};
  const first = await request('/api/orders', {method: 'POST', token: beta.token, body, headers});
  assert.equal(first.status, 201);
  const retry = await request('/api/orders', {method: 'POST', token: beta.token, body, headers});
  assert.equal(retry.status, 200);
  assert.equal(retry.data.order.token, first.data.order.token);
  const changed = await request('/api/orders', {method: 'POST', token: beta.token, body: {...body, amount: '1399.25'}, headers});
  assert.equal(changed.status, 409);
});

test('money validation rejects permissive parsing, negative and fractional-paise values', async () => {
  for (const amount of ['10oops', '1.001', '-1', 'Infinity', '1e3', 0]) {
    const result = await request('/api/orders', {method: 'POST', token: beta.token, body: {itemDescription: 'Bad amount', amount}});
    assert.equal(result.status, 400, `accepted invalid amount ${amount}`);
  }
});

test('public lifecycle events never disclose addresses, editing sessions or staff notes', async () => {
  const order = await createOrder(beta, {customerInstructions: 'Public instruction', internalNotes: 'Staff-only secret'});
  const saved = await request(`/api/orders/${order.token}/address`, {method: 'POST', body: {fullName: 'Test Recipient', phone: '9000000001', flat: 'Private House 99', street: 'Private Street', pincode: '560038', city: 'Bengaluru', state: 'Karnataka'}});
  assert.equal(saved.status, 200);
  const event = await request(`/api/orders/${order.token}/event`, {method: 'POST', body: {event: 'LINK_OPENED'}});
  assert.equal(event.status, 200);
  const json = JSON.stringify(event.data);
  for (const secret of ['Staff-only secret', 'Private House 99', saved.data.customerSessionKey]) assert.ok(!json.includes(secret));
  assert.equal(event.data.order.customerInstructions, 'Public instruction');
});

test('solo stores have no default staff credentials and discovery needs an exact store', async () => {
  const result = await request('/api/auth/register', {method: 'POST', body: {email: 'solo@example.test', password: 'Long-test-password-2026!', brandName: 'Solo Store', upiId: 'solo@test', salesmen: []}});
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.seller.salesmen, []);
  assert.deepEqual((await request('/api/public/stores')).data.stores, []);
  const found = await request('/api/public/stores?storeId=' + encodeURIComponent(result.data.seller.id));
  assert.equal(found.data.stores.length, 1);
  assert.equal(found.data.stores[0].id, result.data.seller.id);
  const records = JSON.parse(await fs.readFile(path.join(tempDir, 'data', 'sellers.json'), 'utf8'));
  const alphaStaff = records.find(seller => seller.id === beta.seller.id).salesmen[0];
  assert.equal(alphaStaff.pin, undefined);
  assert.ok(alphaStaff.pinHash && alphaStaff.pinSalt);
});

test('cancelled checkout cannot be paid or rewritten by a customer', async () => {
  const order = await createOrder(beta);
  assert.equal((await request(`/api/orders/${order.token}/dispatch`, {method: 'POST', token: beta.token, body: {status: 'CANCELLED'}})).status, 200);
  assert.equal((await request(`/api/orders/${order.token}/utr`, {method: 'POST', body: {utr: '100000000888'}})).status, 409);
  assert.equal((await request(`/api/orders/${order.token}/mark-paid`, {method: 'POST', token: beta.token, body: {paymentMethod: 'Cash'}})).status, 409);
});

test('bank receipt ingestion rejects debit and forged sender and keeps valid receipts for review by default', async () => {
  await request('/api/store/settings', {method: 'PUT', token: beta.token, body: {bankingAutomation: {bankCode: 'HDFC', verifiedSenderEmail: 'alerts@hdfcbank.net', monitoringActive: false}}});
  const order = await createOrder(beta, {amount: '640.50'});
  const headers = {'x-webhook-secret': webhookSecret, 'x-store-id': beta.seller.id};
  const send = (from, text, id, utr) => request('/api/webhook/bank-email', {method: 'POST', headers, body: {from, text: `INR 640.50 ${text} UTR ${utr} REF ${order.token}`, messageId: id, emailAuthenticationPassed: true}});
  const debit = await send('alerts@hdfcbank.net', 'debited', 'test-debit', '100000000771');
  assert.equal(debit.data.ignored, true);
  const forged = await send('alerts@hdfcbank.net.attacker.test', 'credited', 'test-forged', '100000000772');
  assert.equal(forged.data.ignored, true);
  const valid = await send('alerts@hdfcbank.net', 'credited', 'test-credit', '100000000773');
  assert.equal(valid.data.reviewRequired, true);
  assert.equal((await request(`/api/orders/${order.token}`, {token: beta.token})).data.order.status, 'PENDING');
  await send('alerts@hdfcbank.net', 'credited', 'test-credit', '100000000773');
  const ledger = JSON.parse(await fs.readFile(path.join(tempDir, 'data', 'unmatched_credits.json'), 'utf8'));
  assert.equal(ledger.filter(credit => credit.utr === '100000000773').length, 1);
  const reported = await request(`/api/orders/${order.token}/utr`, {method: 'POST', body: {utr: '100000000773'}});
  assert.equal(reported.status, 202, 'Reference must not bypass review-only mode');
  assert.equal(reported.data.verified, false);
});


test('last-unit settlement never oversells and leaves a second order for review', async () => {
  const product = await request('/api/products', {method: 'POST', token: beta.token, body: {name: 'Last synthetic unit', sku: 'LAST-ONE', price: 200, stock: 1}});
  assert.equal(product.status, 201);
  const first = await createOrder(beta, {itemDescription: 'Last synthetic unit', sku: 'LAST-ONE', amount: 200});
  const second = await createOrder(beta, {itemDescription: 'Last synthetic unit', sku: 'LAST-ONE', amount: 200});
  const settled = await request(`/api/orders/${first.token}/mark-paid`, {method: 'POST', token: beta.token, body: {paymentMethod: 'Cash'}});
  assert.equal(settled.status, 200);
  const conflict = await request(`/api/orders/${second.token}/mark-paid`, {method: 'POST', token: beta.token, body: {paymentMethod: 'Cash'}});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.order.paymentStatus, 'REVIEW_REQUIRED');
  const catalog = await request('/api/products', {token: beta.token});
  assert.equal(catalog.data.products.find(item => item.sku === 'LAST-ONE').stock, 0);
});

test('cancelling a paid order preserves payment and creates a refund task', async () => {
  const order = await createOrder(beta);
  await request(`/api/orders/${order.token}/mark-paid`, {method: 'POST', token: beta.token, body: {paymentMethod: 'Cash'}});
  const cancelled = await request(`/api/orders/${order.token}/dispatch`, {method: 'POST', token: beta.token, body: {status: 'CANCELLED'}});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.status, 'PAID');
  assert.equal(cancelled.data.order.paymentStatus, 'REFUND_REQUIRED');
  assert.equal(cancelled.data.order.dispatchStatus, 'CANCELLED');
});

test('failed settings validation is atomic and password changes revoke other sessions', async () => {
  const before = await request('/api/store/settings', {token: beta.token});
  const failed = await request('/api/store/settings', {method: 'PUT', token: beta.token, body: {brandName: 'Should not persist', newPassword: 'Changed-test-password-2026!', currentPassword: 'Wrong-password'}});
  assert.equal(failed.status, 403);
  assert.equal((await request('/api/store/settings', {token: beta.token})).data.settings.brandName, before.data.settings.brandName);
  const login = await request('/api/auth/login', {method: 'POST', body: {email: 'beta@example.test', password: 'Synthetic-test-password-2026!'}});
  assert.equal(login.status, 200);
  const changed = await request('/api/store/settings', {method: 'PUT', token: beta.token, body: {newPassword: 'Changed-test-password-2026!', currentPassword: 'Synthetic-test-password-2026!'}});
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/orders', {token: login.data.token})).status, 401);
  assert.equal((await request('/api/orders', {token: beta.token})).status, 200);
});

test('production headers, readiness and input errors have usable contracts', async () => {
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  const policy = health.headers.get('content-security-policy');
  assert.ok(policy.includes("default-src 'self'"));
  assert.ok(policy.includes("object-src 'none'"));
  assert.equal((await request('/readyz')).status, 200);
  const malformed = await request('/api/auth/register', {method: 'POST', body: {email: {}, password: '123', brandName: 'Bad', upiId: 'bad@test'}});
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.data.error, 'string');
});

test('active pages use compiled CSS and inline scripts parse cleanly', async () => {
  const vm = require('node:vm');
  for (const name of ['index.html', 'auth.html', 'pay.html']) {
    const html = await fs.readFile(path.join(root, 'public', name), 'utf8');
    assert.ok(!html.includes('cdn.tailwindcss.com'), `${name} still depends on runtime Tailwind`);
    for (const match of html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], {filename: name});
  }
});


test('staff cancellation and unsafe mailbox destinations are rejected', async () => {
  const created = await request('/api/store/salesmen', {method: 'POST', token: beta.token, body: {name: 'Fulfillment Staff', pin: '3728'}});
  assert.equal(created.status, 201);
  const login = await request('/api/auth/salesman-login', {method: 'POST', body: {storeId: beta.seller.id, salesmanId: created.data.salesman.id, pin: '3728'}});
  assert.equal(login.status, 200);
  const order = await createOrder(login.data);
  assert.equal((await request(`/api/orders/${order.token}/dispatch`, {method: 'POST', token: login.data.token, body: {status: 'CANCELLED'}})).status, 403);
  const unsafe = await request('/api/seller/test-email-connection', {method: 'POST', token: beta.token, body: {imapHost: '127.0.0.1', imapPort: 993, imapUser: 'test@example.test', imapAppPassword: 'synthetic-only'}});
  assert.equal(unsafe.status, 400);
});


test('offline postal lookup never substitutes a city guessed from the prefix', async () => {
  const known = await request('/api/pincode/560038');
  assert.equal(known.status, 200);
  const unknown = await request('/api/pincode/560999');
  assert.equal(unknown.status, 503);
  assert.equal(unknown.data.success, false);
  assert.equal(unknown.data.data, undefined);
});

test('store themes persist and existing checkout links use the merchant’s current theme', async () => {
  const before = await request('/api/store/settings', {token: alpha.token});
  assert.equal(before.status, 200);
  assert.equal(before.data.settings.themeId, 'lavender');
  const existingOrder = await createOrder(alpha, {itemDescription: 'Theme regression item'});
  const initialCheckout = await request(`/api/orders/${existingOrder.token}`);
  assert.equal(initialCheckout.data.order.themeId, 'lavender');

  const saved = await request('/api/store/settings', {method: 'PUT', token: alpha.token, body: {themeId: 'ocean'}});
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.themeId, 'ocean');
  assert.equal(saved.data.settings.brandColor, '#176497');
  const settings = await request('/api/store/settings', {token: alpha.token});
  assert.equal(settings.data.settings.themeId, 'ocean');
  const records = JSON.parse(await fs.readFile(path.join(tempDir, 'data', 'sellers.json'), 'utf8'));
  assert.equal(records.find(seller => seller.id === alpha.seller.id).themeId, 'ocean');
  const checkout = await request(`/api/orders/${existingOrder.token}`);
  assert.equal(checkout.status, 200);
  assert.equal(checkout.data.order.themeId, 'ocean', 'An old link must not retain a stale theme snapshot');
  assert.equal(checkout.data.order.brandColor, '#176497');
  assert.equal((await request('/api/auth/me', {token: alpha.token})).data.seller.themeId, 'ocean');
  assert.equal((await request('/api/store/settings', {token: beta.token})).data.settings.themeId, 'lavender', 'Theme updates must stay within the merchant');

  for (const themeId of ['not-a-theme', '#176497', 'ocean ', null, false, {}]) {
    const invalid = await request('/api/store/settings', {method: 'PUT', token: alpha.token, body: {themeId, brandName: 'Must not persist'}});
    assert.equal(invalid.status, 400, `Accepted invalid theme ${JSON.stringify(themeId)}`);
  }
  const afterInvalid = await request('/api/store/settings', {token: alpha.token});
  assert.equal(afterInvalid.data.settings.themeId, 'ocean');
  assert.equal(afterInvalid.data.settings.brandName, before.data.settings.brandName, 'Invalid themes must not partially update settings');
});

async function createInventoryStaff(pin, name) {
  const created = await request('/api/store/salesmen', {method: 'POST', token: alpha.token, body: {name, pin}});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.salesman.stockAccess, false, 'New staff must have no inventory editing grant');
  const login = await request('/api/auth/salesman-login', {method: 'POST', body: {storeId: alpha.seller.id, salesmanId: created.data.salesman.id, pin}});
  assert.equal(login.status, 200);
  assert.equal(login.data.stockAccess, false);
  return {id: created.data.salesman.id, token: login.data.token};
}

test('staff without an inventory grant can sell but cannot mutate stock or save catalog items', async () => {
  const employee = await createInventoryStaff('6831', 'Inventory denied regression staff');
  const product = await request('/api/products', {method: 'POST', token: alpha.token, body: {name: 'Protected inventory item', sku: 'PERM-DENIED', price: 125, stock: 4}});
  assert.equal(product.status, 201);
  const productId = product.data.product.id;
  assert.equal((await request('/api/products', {token: employee.token})).status, 200, 'Selling staff still need to view the catalog');
  await createOrder(employee, {itemDescription: 'Protected inventory item', sku: 'PERM-DENIED', amount: 125});
  assert.equal((await request('/api/products', {method: 'POST', token: employee.token, body: {name: 'Forbidden item', sku: 'FORBIDDEN', price: 100, stock: 1}})).status, 403);
  assert.equal((await request(`/api/products/${productId}/stock`, {method: 'PUT', token: employee.token, body: {delta: 3}})).status, 403);
  assert.equal((await request(`/api/products/${productId}`, {method: 'DELETE', token: employee.token})).status, 403);
  assert.equal((await request('/api/store/settings', {method: 'PUT', token: employee.token, body: {themeId: 'rose'}})).status, 403, 'Staff may not change store branding');

  const ordersBefore = (await request('/api/orders', {token: alpha.token})).data.orders.length;
  const unauthorizedSave = await request('/api/orders', {method: 'POST', token: employee.token, body: {itemDescription: 'Unauthorized catalog save', sku: 'FORBIDDEN-SAVE', amount: 100, saveToCatalog: true}});
  assert.equal(unauthorizedSave.status, 403);
  assert.equal((await request('/api/orders', {token: alpha.token})).data.orders.length, ordersBefore, 'A denied catalog save must not create an order');
  assert.equal((await request('/api/products/FORBIDDEN-SAVE', {token: alpha.token})).status, 404, 'A denied catalog save must not add a product');
  assert.equal((await request(`/api/products/${productId}`, {token: alpha.token})).data.product.stock, 4, 'Denied operations must leave inventory untouched');
});

test('inventory grants and revocations take effect on an already active staff token', async () => {
  const employee = await createInventoryStaff('6832', 'Inventory grant regression staff');
  const granted = await request(`/api/store/salesmen/${employee.id}`, {method: 'PUT', token: alpha.token, body: {stockAccess: true}});
  assert.equal(granted.status, 200);
  assert.equal(granted.data.salesman.stockAccess, true);
  assert.equal((await request('/api/auth/me', {token: employee.token})).data.stockAccess, true, 'The existing token must gain the new grant');
  const product = await request('/api/products', {method: 'POST', token: employee.token, body: {name: 'Granted inventory item', sku: 'PERM-GRANTED', price: 150, stock: 2}});
  assert.equal(product.status, 201);
  const productId = product.data.product.id;
  const restocked = await request(`/api/products/${productId}/stock`, {method: 'PUT', token: employee.token, body: {delta: 3}});
  assert.equal(restocked.status, 200);
  assert.equal(restocked.data.product.stock, 5);
  await createOrder(employee, {itemDescription: 'Granted catalog save', sku: 'GRANTED-SAVE', amount: 100, saveToCatalog: true});
  assert.equal((await request('/api/products/GRANTED-SAVE', {token: alpha.token})).status, 200);
  const disposable = await request('/api/products', {method: 'POST', token: employee.token, body: {name: 'Disposable granted item', sku: 'GRANTED-DELETE', price: 100, stock: 1}});
  assert.equal(disposable.status, 201);
  assert.equal((await request(`/api/products/${disposable.data.product.id}`, {method: 'DELETE', token: employee.token})).status, 200);

  const revoked = await request(`/api/store/salesmen/${employee.id}`, {method: 'PUT', token: alpha.token, body: {stockAccess: false}});
  assert.equal(revoked.status, 200);
  const stillSignedIn = await request('/api/auth/me', {token: employee.token});
  assert.equal(stillSignedIn.data.authenticated, true, 'Revoking inventory should preserve ordinary staff sign-in');
  assert.equal(stillSignedIn.data.stockAccess, false);
  assert.equal((await request(`/api/products/${productId}/stock`, {method: 'PUT', token: employee.token, body: {stock: 99}})).status, 403);
  assert.equal((await request(`/api/products/${productId}`, {method: 'DELETE', token: employee.token})).status, 403);
  assert.equal((await request('/api/products', {method: 'POST', token: employee.token, body: {name: 'Revoked item', price: 100, stock: 1}})).status, 403);
  assert.equal((await request(`/api/products/${productId}`, {token: alpha.token})).data.product.stock, 5, 'Revoked active tokens must not change saved stock');
});

test('string boolean inputs cannot silently grant inventory access or save catalog items', async () => {
  const rejected = await request('/api/store/salesmen', {method: 'POST', token: alpha.token, body: {name: 'Invalid permission staff', pin: '6833', stockAccess: 'false'}});
  assert.equal(rejected.status, 400);
  assert.ok(!(await request('/api/store/salesmen', {token: alpha.token})).data.salesmen.some(member => member.name === 'Invalid permission staff'));
  const employee = await createInventoryStaff('6834', 'Boolean regression staff');
  const invalidUpdate = await request(`/api/store/salesmen/${employee.id}`, {method: 'PUT', token: alpha.token, body: {name: 'Must not persist', stockAccess: 'false'}});
  assert.equal(invalidUpdate.status, 400);
  const member = (await request('/api/store/salesmen', {token: alpha.token})).data.salesmen.find(member => member.id === employee.id);
  assert.equal(member.name, 'Boolean regression staff');
  assert.equal(member.stockAccess, false);
  assert.equal((await request('/api/auth/me', {token: employee.token})).data.stockAccess, false);
  const ordersBefore = (await request('/api/orders', {token: alpha.token})).data.orders.length;
  const invalidSave = await request('/api/orders', {method: 'POST', token: alpha.token, body: {itemDescription: 'Invalid catalog boolean', sku: 'STRING-FALSE', amount: 100, saveToCatalog: 'false'}});
  assert.equal(invalidSave.status, 400);
  assert.equal((await request('/api/orders', {token: alpha.token})).data.orders.length, ordersBefore);
  assert.equal((await request('/api/products/STRING-FALSE', {token: alpha.token})).status, 404);
});


test('email settings are explicit, owner-only and survive unrelated profile saves', async () => {
  const enabled = await request('/api/store/settings', {method:'PUT',token:alpha.token,body:{bankingAutomation:{monitoringActive:true,confirmationMode:'automatic'}}});
  assert.equal(enabled.status,200);
  assert.equal(enabled.data.settings.bankingAutomation.confirmationMode,'automatic');
  await request('/api/store/settings',{method:'PUT',token:alpha.token,body:{ownerName:'Updated synthetic owner',bankingAutomation:{bankCode:'HDFC',verifiedSenderEmail:'alerts@hdfcbank.net'}}});
  const settings=(await request('/api/store/settings',{token:alpha.token})).data.settings.bankingAutomation;
  assert.equal(settings.monitoringActive,true);assert.equal(settings.confirmationMode,'automatic');
  for (const flags of [{monitoringActive:'false'},{confirmationMode:'invalid'}]) assert.equal((await request('/api/store/settings',{method:'PUT',token:alpha.token,body:{bankingAutomation:flags}})).status,400);
  const created=await request('/api/store/salesmen',{method:'POST',token:alpha.token,body:{name:'Mail settings staff',pin:'8374'}});
  const signedIn=await request('/api/auth/salesman-login',{method:'POST',body:{storeId:alpha.seller.id,salesmanId:created.data.salesman.id,pin:'8374'}});
  assert.equal((await request('/api/store/settings',{method:'PUT',token:signedIn.data.token,body:{bankingAutomation:{confirmationMode:'automatic'}}})).status,403);
});

test('automatic confirmation settles a fresh authenticated email match exactly once',async()=>{
  const product=await request('/api/products',{method:'POST',token:alpha.token,body:{name:'Email synthetic item',sku:'EMAIL-ONCE',price:307,stock:2}});
  assert.equal(product.status,201);
  const order=await createOrder(alpha,{amount:307,sku:'EMAIL-ONCE',itemDescription:'Email synthetic item'});
  const message={from:'alerts@hdfcbank.net',text:`INR 307 credited UTR 100000009901 REF ${order.token}`,emailAuthenticationPassed:true,messageId:'fresh-email-test',receivedAt:new Date().toISOString()};
  const send=()=>request('/api/webhook/bank-email',{method:'POST',headers:{'x-webhook-secret':webhookSecret,'x-store-id':alpha.seller.id},body:message});
  const result=await send();assert.equal(result.data.success,true);assert.equal(result.data.order.status,'PAID');
  assert.equal((await send()).data.duplicate,true);
  const catalog=await request('/api/products',{token:alpha.token});assert.equal(catalog.data.products.find(p=>p.sku==='EMAIL-ONCE').stock,1);
});

test('old authenticated receipt cannot settle via either email or customer-reference route',async()=>{
  const order=await createOrder(alpha,{amount:308});
  const message={from:'alerts@hdfcbank.net',text:`INR 308 credited UTR 100000009902 REF ${order.token}`,emailAuthenticationPassed:true,messageId:'old-email-test',receivedAt:'2020-01-01T00:00:00Z'};
  const result=await request('/api/webhook/bank-email',{method:'POST',headers:{'x-webhook-secret':webhookSecret,'x-store-id':alpha.seller.id},body:message});
  assert.equal(result.data.reviewRequired,true);
  const reported=await request(`/api/orders/${order.token}/utr`,{method:'POST',body:{utr:'100000009902'}});
  assert.equal(reported.status,202);assert.equal(reported.data.verified,false);
  assert.equal((await request(`/api/orders/${order.token}`,{token:alpha.token})).data.order.status,'PENDING');
});


test('a fresh receipt arriving before its customer reference confirms only after association',async()=>{
  const order=await createOrder(alpha,{amount:309});
  const received=await request('/api/webhook/bank-email',{method:'POST',headers:{'x-webhook-secret':webhookSecret,'x-store-id':alpha.seller.id},body:{from:'alerts@hdfcbank.net',text:'INR 309 credited UTR 100000009903',emailAuthenticationPassed:true,messageId:'receipt-before-reference',receivedAt:new Date().toISOString()}});
  assert.equal(received.data.reviewRequired,true);
  assert.equal((await request(`/api/orders/${order.token}`,{token:alpha.token})).data.order.status,'PENDING');
  const reported=await request(`/api/orders/${order.token}/utr`,{method:'POST',body:{utr:'100000009903'}});
  assert.equal(reported.status,200);assert.equal(reported.data.verified,true);assert.equal(reported.data.order.status,'PAID');
});
