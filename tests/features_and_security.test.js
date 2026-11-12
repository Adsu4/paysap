// Automated tests for PaySap security hardening, new product flows, and mocked PostgresStore transactions.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const { PostgresStore } = require('../src/storage/postgresStore');

const root = path.resolve(__dirname, '..');
let tempDir, child, baseUrl, resetWebhookServer, resetWebhookPort, startupOutput = '';
let owner, staff, capturedResetPayloads = [];

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

async function request(route, { method = 'GET', token, body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  return { status: response.status, data, headers: response.headers, setCookie };
}

before(async () => {
  // Loopback receiver for PASSWORD_RESET_WEBHOOK_URL (allowed by no-external-network.cjs)
  resetWebhookServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { capturedResetPayloads.push(JSON.parse(raw)); } catch { capturedResetPayloads.push(raw); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  resetWebhookServer.listen(0, '127.0.0.1');
  await once(resetWebhookServer, 'listening');
  resetWebhookPort = resetWebhookServer.address().port;

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paysap-features-'));
  const dataDir = path.join(tempDir, 'data');
  await fs.mkdir(dataDir);
  for (const [name, value] of Object.entries({ sellers: [], orders: [], products: [], sessions: {}, unmatched_credits: [], password_resets: [] })) {
    await fs.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(value));
  }

  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    DISABLE_BANK_POLLING: '1',
    APP_URL: baseUrl,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    WEBHOOK_SHARED_SECRET: crypto.randomBytes(32).toString('hex'),
    PASSWORD_RESET_WEBHOOK_URL: `http://127.0.0.1:${resetWebhookPort}/reset-hook`,
    ENABLE_EMAIL_AUTO_CONFIRMATION: '0'
  });

  child = spawn(process.execPath, ['--require', path.join(__dirname, 'no-external-network.cjs'), path.join(root, 'server.js')], {
    cwd: tempDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { startupOutput = (startupOutput + chunk).slice(-12000); });

  const deadline = Date.now() + 30000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Isolated server exited (${child.exitCode}): ${startupOutput}`);
    try {
      const ready = await request('/healthz');
      if (ready.status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Isolated server did not start: ${startupOutput}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const reg = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'merchant@example.test',
      password: 'Merchant-Initial-Pass-2026!',
      brandName: 'Kala Studio',
      ownerName: 'Asha',
      phone: '9000000010',
      upiId: 'kalastudio@test',
      salesmen: [{ name: 'Neha', pin: '4826' }, { name: 'Rohan', pin: '7391' }]
    }
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  owner = {
    ...reg.data,
    cookiePair: reg.setCookie.find(c => c.startsWith('auth_token=')).split(';')[0]
  };

  const staffLogin = await request('/api/auth/salesman-login', {
    method: 'POST',
    body: { storeId: owner.seller.id, salesmanId: owner.seller.salesmen[0].id, pin: '4826' }
  });
  assert.equal(staffLogin.status, 200);
  staff = staffLogin.data;
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 4000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (resetWebhookServer) resetWebhookServer.close();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('strict CSP header disables inline scripts and HTML/JS templates contain zero inline handlers', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);

  const publicHtml = ['index.html', 'auth.html', 'pay.html'];
  for (const file of publicHtml) {
    const content = await fs.readFile(path.join(root, 'public', file), 'utf8');
    assert.equal(/\bon[a-z]+\s*=/i.test(content), false, `Found inline event handler in public/${file}`);
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(content), false, `Found inline <script> in public/${file}`);
  }

  const jsFiles = await fs.readdir(path.join(root, 'public', 'js'));
  for (const file of jsFiles.filter(f => f.endsWith('.js'))) {
    const content = await fs.readFile(path.join(root, 'public', 'js', file), 'utf8');
    assert.equal(/<[a-zA-Z][^>]*\son[a-z]+\s*=/i.test(content), false, `Found inline on* in template string inside public/js/${file}`);
  }
});

test('CSRF origin guard blocks cross-origin cookie-authenticated POST while allowing same-origin POST', async () => {
  const blockedCrossOrigin = await request('/api/orders', {
    method: 'POST',
    cookie: owner.cookiePair,
    headers: { Origin: 'https://evil.example' },
    body: { customerPhone: '9000000011', itemDescription: 'Blocked item', amount: 100 }
  });
  assert.equal(blockedCrossOrigin.status, 403);

  const blockedSecFetch = await request('/api/orders', {
    method: 'POST',
    cookie: owner.cookiePair,
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { customerPhone: '9000000011', itemDescription: 'Blocked item', amount: 100 }
  });
  assert.equal(blockedSecFetch.status, 403);

  const allowedSameOrigin = await request('/api/orders', {
    method: 'POST',
    cookie: owner.cookiePair,
    headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    body: { customerPhone: '9000000011', itemDescription: 'Same-origin item', amount: 150 }
  });
  assert.equal(allowedSameOrigin.status, 201, JSON.stringify(allowedSameOrigin.data));
});

test('per-account salesman PIN lockout triggers 429 after repeated failures without blocking other staff', async () => {
  const lockedStaffId = owner.seller.salesmen[1].id;
  for (let i = 0; i < 5; i++) {
    const fail = await request('/api/auth/salesman-login', {
      method: 'POST',
      body: { storeId: owner.seller.id, salesmanId: lockedStaffId, pin: '0000' }
    });
    assert.equal(fail.status, 401);
  }
  const locked = await request('/api/auth/salesman-login', {
    method: 'POST',
    body: { storeId: owner.seller.id, salesmanId: lockedStaffId, pin: '7391' }
  });
  assert.equal(locked.status, 429);

  // Separate staff account still logs in cleanly
  const otherStaff = await request('/api/auth/salesman-login', {
    method: 'POST',
    body: { storeId: owner.seller.id, salesmanId: owner.seller.salesmen[0].id, pin: '4826' }
  });
  assert.equal(otherStaff.status, 200);
});

test('multi-item order computes breakdown, serves public receipt breakdown, and decrements catalog stock atomically on payment', async () => {
  const p1 = await request('/api/products', {
    method: 'POST',
    token: owner.token,
    body: { name: 'Linen Kurta', sku: 'LIN-001', price: 1200, stock: 5, category: 'Apparel' }
  });
  const p2 = await request('/api/products', {
    method: 'POST',
    token: owner.token,
    body: { name: 'Cotton Stole', sku: 'STL-002', price: 300, stock: 4, category: 'Accessories' }
  });
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 201);

  const created = await request('/api/orders', {
    method: 'POST',
    token: owner.token,
    body: {
      customerName: 'Multi Buyer',
      customerPhone: '9000000022',
      items: [
        { productId: p1.data.product.id, sku: 'LIN-001', name: 'Linen Kurta', quantity: 2, unitPrice: 1200 },
        { productId: p2.data.product.id, sku: 'STL-002', name: 'Cotton Stole', quantity: 1, unitPrice: 300 }
      ],
      shippingAmount: 100,
      discountAmount: 200
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const order = created.data.order;
  assert.equal(order.subtotalAmount, 2700);
  assert.equal(order.shippingAmount, 100);
  assert.equal(order.discountAmount, 200);
  assert.equal(order.amount, 2600);
  assert.equal(order.items.length, 2);

  // Public checkout endpoint exposes normalized items breakdown without internal notes
  const pub = await request(`/api/orders/${order.token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.order.items.length, 2);
  assert.equal(pub.data.order.shippingAmount, 100);
  assert.equal(pub.data.order.discountAmount, 200);

  // Owner settles order -> stock decrements for both catalog items
  const paid = await request(`/api/orders/${order.ref}/mark-paid`, {
    method: 'POST',
    token: owner.token,
    body: { utr: '999888777666', paymentMethod: 'Bank Transfer' }
  });
  assert.equal(paid.status, 200);

  const catalog = await request('/api/products', { token: owner.token });
  assert.equal(catalog.status, 200);
  const kurta = catalog.data.products.find(p => p.id === p1.data.product.id);
  const stole = catalog.data.products.find(p => p.id === p2.data.product.id);
  assert.equal(kurta.stock, 3);
  assert.equal(stole.stock, 3);
});

test('server-side order pagination, filtering, summary metrics, and owner refund logging (full and partial)', async () => {
  // Cancel & record partial refund on one paid order, and full refund on another paid order
  const o1 = (await request('/api/orders', {
    method: 'POST', token: owner.token,
    body: { customerPhone: '9000000031', itemDescription: 'Pagination Silk Saree', amount: 2000 }
  })).data.order;
  const o2 = (await request('/api/orders', {
    method: 'POST', token: owner.token,
    body: { customerPhone: '9000000032', itemDescription: 'Pagination Silver Bangle', amount: 800 }
  })).data.order;

  await request(`/api/orders/${o1.ref}/mark-paid`, { method: 'POST', token: owner.token, body: { utr: '111222333444' } });
  await request(`/api/orders/${o2.ref}/mark-paid`, { method: 'POST', token: owner.token, body: { utr: '111222333445' } });
  const c1 = await request(`/api/orders/${o1.ref}/dispatch`, { method: 'POST', token: owner.token, body: { status: 'CANCELLED' } });
  const c2 = await request(`/api/orders/${o2.ref}/dispatch`, { method: 'POST', token: owner.token, body: { status: 'CANCELLED' } });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);

  // Staff cannot record refund
  const staffRefund = await request(`/api/orders/${o1.ref}/refund`, {
    method: 'POST', token: staff.token, body: { amount: 500, method: 'UPI Refund' }
  });
  assert.equal(staffRefund.status, 403);

  // Over-amount refund rejected
  const overRefund = await request(`/api/orders/${o1.ref}/refund`, {
    method: 'POST', token: owner.token, body: { amount: 5000, method: 'UPI Refund' }
  });
  assert.equal(overRefund.status, 400);

  // Summary reports 2 refund-required orders right now
  const summaryBefore = await request('/api/orders/summary', { token: owner.token });
  assert.equal(summaryBefore.status, 200);
  assert.equal(summaryBefore.data.metrics.refundRequiredCount, 2);

  // Partial refund
  const partialRes = await request(`/api/orders/${o1.ref}/refund`, {
    method: 'POST', token: owner.token,
    body: { amount: 1500, method: 'UPI Refund', reference: 'RFD-PART-1', notes: 'Restocking fee deducted' }
  });
  assert.equal(partialRes.status, 200);
  assert.equal(partialRes.data.order.paymentStatus, 'PARTIALLY_REFUNDED');
  assert.equal(partialRes.data.order.refundDetails.amount, 1500);

  // Full refund
  const fullRes = await request(`/api/orders/${o2.ref}/refund`, {
    method: 'POST', token: owner.token,
    body: { method: 'Bank Transfer', reference: 'RFD-FULL-2' }
  });
  assert.equal(fullRes.status, 200);
  assert.equal(fullRes.data.order.paymentStatus, 'REFUNDED');
  assert.equal(fullRes.data.order.refundDetails.amount, 800);

  // Public receipt reflects refunded state without leaking internal refund notes if sensitive fields aren't exposed
  const pubRefunded = await request(`/api/orders/${o2.token}`);
  assert.equal(pubRefunded.status, 200);
  assert.equal(pubRefunded.data.order.paymentStatus, 'REFUNDED');
  assert.equal(pubRefunded.data.order.refundDetails.amount, 800);

  // Pagination & search
  const page1 = await request('/api/orders?page=1&limit=2&status=PAID', { token: owner.token });
  assert.equal(page1.status, 200);
  assert.equal(page1.data.orders.length, 2);
  assert.equal(page1.data.pagination.page, 1);
  assert.equal(page1.data.pagination.limit, 2);
  assert.ok(page1.data.pagination.total >= 3);

  const searchRes = await request('/api/orders?page=1&limit=10&search=Pagination%20Silver', { token: owner.token });
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.data.orders.length, 1);
  assert.equal(searchRes.data.orders[0].ref, o2.ref);
});

test('owner forgot-password issues single-use reset token, revokes active sessions, and sets new password', async () => {
  // Confirm existing owner token currently works
  const meBefore = await request('/api/auth/me', { token: owner.token });
  assert.equal(meBefore.data.authenticated, true);

  capturedResetPayloads = [];
  const forgot = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'merchant@example.test' }
  });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.data.resetToken, undefined, 'Reset token must not leak in HTTP response');

  // Wait briefly for loopback webhook delivery
  for (let i = 0; i < 20 && capturedResetPayloads.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(capturedResetPayloads.length, 1);
  const resetToken = capturedResetPayloads[0].resetToken;
  assert.ok(resetToken && /^[a-f0-9]{48}$/.test(resetToken));

  const reset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'Merchant-Rotated-Pass-2026!' }
  });
  assert.equal(reset.status, 200);

  // Single-use: second attempt fails
  const replay = await request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'Another-Password-2026!' }
  });
  assert.equal(replay.status, 400);

  // Previous session invalidated
  const meAfter = await request('/api/auth/me', { token: owner.token });
  assert.equal(meAfter.data.authenticated, false);

  // Old password rejected, new password succeeds
  const oldLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'merchant@example.test', password: 'Merchant-Initial-Pass-2026!' }
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'merchant@example.test', password: 'Merchant-Rotated-Pass-2026!' }
  });
  assert.equal(newLogin.status, 200);
});

test('PostgresStore withTransaction issues BEGIN/COMMIT, applies FOR UPDATE row locks, and rolls back on failure', async () => {
  const queries = [];
  let released = false;
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    }
  };
  const mockPool = {
    async connect() { return mockClient; },
    async query(sql, params) { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    async end() {}
  };

  const pgStore = new PostgresStore(null, { pool: mockPool });

  // Commit + FOR UPDATE lock verification
  await pgStore.withTransaction(async tx => {
    await tx.findOrderByIdentifier('KAL-001', 'seller_1');
  });
  assert.equal(released, true);
  assert.equal(queries[0].sql, 'BEGIN');
  assert.match(queries[1].sql, /FOR UPDATE$/);
  assert.equal(queries[2].sql, 'COMMIT');

  // Rollback verification on thrown error
  queries.length = 0;
  released = false;
  await assert.rejects(
    pgStore.withTransaction(async () => {
      throw new Error('Synthetic transaction failure');
    }),
    /Synthetic transaction failure/
  );
  assert.equal(released, true);
  assert.deepEqual(queries.map(q => q.sql), ['BEGIN', 'ROLLBACK']);
});
