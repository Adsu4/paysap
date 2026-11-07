const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runPass4RobustnessTests() {
  console.log('🚀 Running Pass 4 Robustness & Edge Cases Verification Suite...\n');

  const sellers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sellers.json'), 'utf8'));
  const sessions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sessions.json'), 'utf8'));

  // Locate an active owner token
  let ownerToken = null;
  let ownerSeller = null;
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.role === 'OWNER') {
      ownerToken = token;
      ownerSeller = sellers.find(s => s.id === sess.sellerId);
      if (ownerSeller) break;
    }
  }

  assert(ownerToken, 'Must have an active owner token');
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };

  // 1. Unsafe Logo Scheme Rejection
  console.log('[1] Testing Unsafe Store Logo Rejection...');
  const resBadLogo = await request('PUT', '/api/store/settings', {
    storeLogo: 'javascript:alert("pwned")'
  }, ownerHeaders);
  assert.strictEqual(resBadLogo.status, 400, 'javascript: storeLogo must be rejected with 400');
  console.log('  ✅ [PASS] javascript: URL scheme in storeLogo rejected with 400!');

  // 2. Safe Settings Return in PUT (No imapAppPassword leak)
  console.log('\n[2] Testing Store Settings Credential Quarantine in PUT Response...');
  const originalBrandName = ownerSeller.brandName;
  const resSafeSettings = await request('PUT', '/api/store/settings', {
    brandName: '<b>Royal Atelier & Couture</b>'
  }, ownerHeaders);
  assert.strictEqual(resSafeSettings.status, 200);
  assert(resSafeSettings.body.settings, 'Response must contain settings');
  assert.strictEqual(resSafeSettings.body.settings.bankingAutomation.imapAppPassword, undefined, 'imapAppPassword must NEVER be leaked in settings PUT response');
  assert.strictEqual(typeof resSafeSettings.body.settings.bankingAutomation.hasAppPassword, 'boolean', 'hasAppPassword must be a boolean');
  assert(resSafeSettings.body.settings.brandName.includes('&lt;b&gt;'), 'HTML tags must be sanitized in brandName');
  // Restore original brand name to avoid state leakage to other test suites
  await request('PUT', '/api/store/settings', { brandName: originalBrandName }, ownerHeaders);
  console.log('  ✅ [PASS] PUT /api/store/settings sanitizes XSS and strictly quarantines passwords/tokens!');

  // 3. Salesman Creation & Active Session Revocation on Deletion
  console.log('\n[3] Testing Salesman Creation, Staff Login & Session Revocation on Delete...');
  const testPin = String(Math.floor(2000 + Math.random() * 7000));
  const resAddStaff = await request('POST', '/api/store/salesmen', {
    name: '<script>alert(1)</script>Amit Kumar',
    pin: testPin,
    stockAccess: false
  }, ownerHeaders);
  assert.strictEqual(resAddStaff.status, 201);
  assert(resAddStaff.body.salesman.name.includes('&lt;script&gt;'), 'Salesman name must be XSS sanitized');
  const staffId = resAddStaff.body.salesman.id;
  console.log(`  ✅ [PASS] Salesman created with sanitized name (ID: ${staffId})`);

  // Staff login via dedicated 4-digit PIN endpoint
  const resStaffLogin = await request('POST', '/api/auth/salesman-login', {
    storeId: ownerSeller.id,
    pin: testPin
  });
  assert.strictEqual(resStaffLogin.status, 200);
  const staffToken = resStaffLogin.body.token;
  assert(staffToken, 'Staff member must receive valid auth token');

  // Verify staff can authenticate
  const resStaffMe = await request('GET', '/api/auth/me', null, { Authorization: `Bearer ${staffToken}` });
  assert.strictEqual(resStaffMe.status, 200);
  assert.strictEqual(resStaffMe.body.role, 'SALESMAN');
  console.log('  ✅ [PASS] Staff successfully logged in and verified active session.');

  // Delete staff member
  const resDeleteStaff = await request('DELETE', `/api/store/salesmen/${staffId}`, null, ownerHeaders);
  assert.strictEqual(resDeleteStaff.status, 200);

  // Verify staff token was immediately revoked
  const resRevokedStaff = await request('GET', '/api/auth/me', null, { Authorization: `Bearer ${staffToken}` });
  assert.strictEqual(resRevokedStaff.body.authenticated, false, 'Deleted salesman session must be invalidated immediately!');
  console.log('  ✅ [PASS] Deleted staff session immediately revoked from sessionsStore (authenticated: false)!');

  // 4. Customer Address Sanitization
  console.log('\n[4] Testing Customer Address Input Sanitization...');
  // Create an order first
  const resOrder = await request('POST', '/api/orders', {
    customerName: 'Priya Sharma',
    customerPhone: '9876543210',
    itemDescription: 'Silk Dupatta',
    amount: 1500
  }, ownerHeaders);
  assert.strictEqual(resOrder.status, 201);
  const orderRef = resOrder.body.order.ref;

  // Submit address with special characters / script tags
  const resAddr = await request('POST', `/api/orders/${orderRef}/address`, {
    fullName: '<script>alert("hack")</script>Priya Sharma',
    phone: '9876543210',
    flat: 'Flat 101 <img src=x onerror=alert(1)>',
    street: 'MG Road',
    pincode: '560001',
    city: 'Bengaluru',
    state: 'Karnataka'
  });
  assert.strictEqual(resAddr.status, 200);
  assert(resAddr.body.order.address.fullName.includes('&lt;script&gt;'), 'fullName must be XSS sanitized');
  assert(resAddr.body.order.address.flat.includes('&lt;img'), 'flat must be XSS sanitized');
  console.log('  ✅ [PASS] Shipping address fields cleanly sanitized against stored XSS!');

  // 5. Order Dispatch Status Enum Validation
  console.log('\n[5] Testing Order Dispatch Status Enum Validation...');
  const resBadDispatch = await request('POST', `/api/orders/${orderRef}/dispatch`, {
    status: 'MALICIOUS_STATUS',
    trackingNumber: 'TRK123'
  }, ownerHeaders);
  assert.strictEqual(resBadDispatch.status, 400, 'Invalid dispatch status must be rejected with 400');

  const resGoodDispatch = await request('POST', `/api/orders/${orderRef}/dispatch`, {
    status: 'dispatched',
    trackingNumber: '<script>AWB9988</script>'
  }, ownerHeaders);
  assert.strictEqual(resGoodDispatch.status, 200);
  assert.strictEqual(resGoodDispatch.body.order.dispatchStatus, 'DISPATCHED');
  assert(resGoodDispatch.body.order.trackingNumber.includes('&lt;script&gt;'), 'trackingNumber must be sanitized');
  console.log('  ✅ [PASS] Dispatch status validated against enum and trackingNumber sanitized!');

  // 6. Multi-Tenant Stock Modification Isolation on Template Products
  console.log('\n[6] Testing Product Stock Edit Tenant Isolation...');
  const resStockEdit = await request('PUT', '/api/products/JWL-201/stock', {
    stock: 42
  }, ownerHeaders);
  assert.strictEqual(resStockEdit.status, 200);
  // Ensure the product returned has the seller's ID (not 'ALL')
  assert.strictEqual(resStockEdit.body.product.sellerId, ownerSeller.id, 'Shared template must be cloned to sellerId upon modification');
  console.log('  ✅ [PASS] Modifying stock on template product cleanly cloned to seller-scoped item!');

  console.log('\n========================================');
  console.log('Final Result: ALL 6 PASS 4 ROBUSTNESS TESTS PASSED (100%)');
  console.log('========================================\n');
}

runPass4RobustnessTests().catch(err => {
  console.error('❌ Pass 4 Verification Failed:', err);
  process.exit(1);
});
