// test_access_separation.js - Automated Verification of Strong Role Separation
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:3000';

async function req(url, options = {}) {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function runTests() {
  console.log('🚀 Starting Bulletproof Access Separation & RBAC Verification...\n');
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  // 1. Authenticate as Store Owner
  const fs = require('fs');
  const sessions = JSON.parse(fs.readFileSync('./data/sessions.json', 'utf8'));
  let ownerToken = Object.entries(sessions).find(([t, s]) => s.sellerId === 'seller_1793462353842_fstlf' && s.role === 'OWNER')?.[0];

  const ownerMeRes = await req('/api/auth/me', {
    headers: { 'Authorization': `Bearer ${ownerToken}` }
  });

  test('Store Owner session verifies with OWNER role', () => {
    assert.strictEqual(ownerMeRes.status, 200);
    assert.strictEqual(ownerMeRes.data.role, 'OWNER');
    assert(ownerMeRes.data.seller, 'Should have received safe seller');
  });

  const ownerHeaders = { 'Authorization': `Bearer ${ownerToken}` };

  // 2. Authenticate as Salesman (Rahul - sm_achu_2: stockAccess: false, PIN: 5678)
  const salesmanRes = await req('/api/auth/salesman-login', {
    method: 'POST',
    body: JSON.stringify({
      storeId: 'seller_1793462353842_fstlf',
      salesmanId: 'sm_achu_2',
      pin: '5678'
    })
  });

  test('Salesman login succeeds with SALESMAN role', () => {
    assert.strictEqual(salesmanRes.status, 200);
    assert.strictEqual(salesmanRes.data.role, 'SALESMAN');
    assert.strictEqual(salesmanRes.data.salesman.id, 'sm_achu_2');
    assert.strictEqual(salesmanRes.data.salesman.name, 'Rahul (Sales)');
  });

  const smToken = salesmanRes.data?.token;
  const smHeaders = { 'Authorization': `Bearer ${smToken}` };

  // 3. Security Leak Quarantine Tests: Salesman session must NEVER see bankingAutomation or salesmen PIN list
  test('Salesman login payload does not leak banking automation or staff PINs', () => {
    assert.strictEqual(salesmanRes.data.seller.bankingAutomation, undefined, 'bankingAutomation leaked!');
    assert.strictEqual(salesmanRes.data.seller.salesmen, undefined, 'salesmen array with PINs leaked!');
  });

  const smMeRes = await req('/api/auth/me', { headers: smHeaders });
  test('GET /api/auth/me for salesman quarantines owner secrets and other staff PINs', () => {
    assert.strictEqual(smMeRes.status, 200);
    assert.strictEqual(smMeRes.data.role, 'SALESMAN');
    assert.strictEqual(smMeRes.data.stockAccess, false);
    assert.strictEqual(smMeRes.data.seller.bankingAutomation, undefined, 'bankingAutomation leaked via /auth/me');
    assert.strictEqual(smMeRes.data.seller.salesmen, undefined, 'salesmen array leaked via /auth/me');
  });

  // 4. Role Enforcement: Owner-Only Endpoints Rejected for Salesman (403 Forbidden)
  const restrictedOwnerRoutes = [
    { method: 'GET', url: '/api/store/settings', name: 'GET /api/store/settings' },
    { method: 'PUT', url: '/api/store/settings', name: 'PUT /api/store/settings', body: { brandName: 'Hacked Brand' } },
    { method: 'GET', url: '/api/store/salesmen', name: 'GET /api/store/salesmen' },
    { method: 'POST', url: '/api/store/salesmen', name: 'POST /api/store/salesmen', body: { name: 'Rogue', pin: '9999' } },
    { method: 'PUT', url: '/api/store/salesmen/sm_achu_1', name: 'PUT /api/store/salesmen/:id', body: { name: 'Renamed' } },
    { method: 'DELETE', url: '/api/store/salesmen/sm_achu_1', name: 'DELETE /api/store/salesmen/:id' },
    { method: 'POST', url: '/api/auth/profile', name: 'POST /api/auth/profile', body: { brandName: 'Tampered Brand' } },
    { method: 'POST', url: '/api/seller/test-email-connection', name: 'POST /api/seller/test-email-connection', body: {} },
    { method: 'POST', url: '/api/seller/test-ingest-email', name: 'POST /api/seller/test-ingest-email', body: {} },
    { method: 'GET', url: '/api/admin/oauth-config', name: 'GET /api/admin/oauth-config' },
    { method: 'POST', url: '/api/admin/oauth-config', name: 'POST /api/admin/oauth-config', body: { clientId: 'x', clientSecret: 'y' } },
    { method: 'GET', url: '/api/auth/google/connect', name: 'GET /api/auth/google/connect' },
    { method: 'POST', url: '/api/auth/google/disconnect', name: 'POST /api/auth/google/disconnect', body: {} }
  ];

  for (const route of restrictedOwnerRoutes) {
    const res = await req(route.url, {
      method: route.method,
      headers: smHeaders,
      body: route.body ? JSON.stringify(route.body) : undefined
    });
    test(`Salesman blocked from ${route.name} (403 Forbidden)`, () => {
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden but got ${res.status}`);
      assert(res.data.error.includes('Access denied'), `Expected error message but got: ${res.data.error}`);
    });
  }

  // 5. Store Owner has Full Access to Settings and Salesmen
  const ownerSettingsRes = await req('/api/store/settings', { headers: ownerHeaders });
  test('Store Owner successfully accesses /api/store/settings', () => {
    assert.strictEqual(ownerSettingsRes.status, 200);
    assert(ownerSettingsRes.data.settings.bankingAutomation, 'Owner should see bankingAutomation');
    assert(Array.isArray(ownerSettingsRes.data.settings.salesmen), 'Owner should see salesmen list');
  });

  // 6. Order Creation & Attribution Locking
  const smOrderRes = await req('/api/orders', {
    method: 'POST',
    headers: smHeaders,
    body: JSON.stringify({
      customerName: 'Aarav Sharma',
      customerPhone: '9876543210',
      itemDescription: 'Handcrafted Silk Stole',
      amount: 1500,
      salesmanId: 'sm_someone_else' // Attempt to spoof salesman ID
    })
  });

  test('Order created by salesman is strictly locked to their session salesmanId', () => {
    assert.strictEqual(smOrderRes.status, 201);
    assert.strictEqual(smOrderRes.data.order.salesmanId, 'sm_achu_2');
    assert.strictEqual(smOrderRes.data.order.salesmanName, 'Rahul (Sales)');
  });

  const createdOrderRef = smOrderRes.data.order.ref;

  // 7. Manual Mark-Paid Route Protection
  const smMarkPaidRes = await req(`/api/orders/${createdOrderRef}/mark-paid`, {
    method: 'POST',
    headers: smHeaders,
    body: JSON.stringify({ paymentMethod: 'Bypassed Payment' })
  });
  test('Salesman blocked from manually overriding payment via mark-paid (403 Forbidden)', () => {
    assert.strictEqual(smMarkPaidRes.status, 403);
    assert(smMarkPaidRes.data.error.includes('Access denied'));
  });

  // 8. Order Query Scoping (GET /api/orders)
  // Create an order by Owner to test isolation
  const ownerOrderRes = await req('/api/orders', {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      customerName: 'Meenakshi Iyer',
      customerPhone: '9988776655',
      itemDescription: 'Heritage Gold Bangle',
      amount: 45000
    })
  });
  const ownerOrderRef = ownerOrderRes.data.order.ref;

  const smOrdersListRes = await req('/api/orders', { headers: smHeaders });
  test('Salesman GET /api/orders only returns orders created by that salesman', () => {
    assert.strictEqual(smOrdersListRes.status, 200);
    const smOrders = smOrdersListRes.data.orders;
    assert(smOrders.some(o => o.ref === createdOrderRef), 'Should contain order created by Rahul');
    assert(!smOrders.some(o => o.ref === ownerOrderRef), 'Should NOT contain order created by Owner');
    for (const o of smOrders) {
      assert.strictEqual(o.salesmanId, 'sm_achu_2', `Order ${o.ref} does not belong to Rahul!`);
    }
  });

  test('Salesman GET /api/orders hides storeFunnel and salesmenBreakdown', () => {
    assert.strictEqual(smOrdersListRes.data.storeFunnel, undefined, 'Store funnel leaked to salesman!');
    assert.strictEqual(smOrdersListRes.data.salesmenBreakdown, undefined, 'Salesmen breakdown leaked to salesman!');
    assert.strictEqual(smOrdersListRes.data.allSalesmen, undefined, 'Staff list leaked to salesman!');
    assert(smOrdersListRes.data.myFunnel, 'Salesman personal funnel should be present');
  });

  // Test bypass attempt: Salesman requests ?salesmanId=ALL or another salesman
  const smBypassQueryRes = await req(`/api/orders?salesmanId=sm_achu_1`, { headers: smHeaders });
  test('Salesman cannot bypass scoping using ?salesmanId query param', () => {
    assert.strictEqual(smBypassQueryRes.status, 200);
    for (const o of smBypassQueryRes.data.orders) {
      assert.strictEqual(o.salesmanId, 'sm_achu_2', 'Salesman bypassed isolation with query parameter!');
    }
  });

  // 9. Dispatch Cross-Salesman Protection
  const smDispatchAttempt = await req(`/api/orders/${ownerOrderRef}/dispatch`, {
    method: 'POST',
    headers: smHeaders,
    body: JSON.stringify({ status: 'DISPATCHED' })
  });
  test('Salesman cannot update dispatch status for another salesman/owner order (403 Forbidden)', () => {
    assert.strictEqual(smDispatchAttempt.status, 403);
    assert(smDispatchAttempt.data.error.includes('Access denied'));
  });

  // Salesman dispatching their OWN order
  const smOwnDispatch = await req(`/api/orders/${createdOrderRef}/dispatch`, {
    method: 'POST',
    headers: smHeaders,
    body: JSON.stringify({ status: 'PACKING', trackingNumber: 'IND12345' })
  });
  test('Salesman can update dispatch status for their OWN order', () => {
    assert.strictEqual(smOwnDispatch.status, 200);
    assert.strictEqual(smOwnDispatch.data.order.dispatchStatus, 'PACKING');
  });

  // 10. Stock CRM Management Permissions
  // Rahul (sm_achu_2) has stockAccess: false
  const smAddProductRes = await req('/api/products', {
    method: 'POST',
    headers: smHeaders,
    body: JSON.stringify({ name: 'Unauthorized SKU', price: 999 })
  });
  test('Salesman without stockAccess is blocked from adding products (403 Forbidden)', () => {
    assert.strictEqual(smAddProductRes.status, 403);
    assert(smAddProductRes.data.error.includes('Access denied'));
  });

  // Log in as Adharsh (sm_achu_1: stockAccess: true, PIN: 1234)
  const smWithStockRes = await req('/api/auth/salesman-login', {
    method: 'POST',
    body: JSON.stringify({
      storeId: 'seller_1793462353842_fstlf',
      salesmanId: 'sm_achu_1',
      pin: '1234'
    })
  });
  const smStockToken = smWithStockRes.data?.token;
  const smStockHeaders = { 'Authorization': `Bearer ${smStockToken}` };

  const smStockAddProd = await req('/api/products', {
    method: 'POST',
    headers: smStockHeaders,
    body: JSON.stringify({
      name: 'Authorized Staff Product',
      sku: 'STF-PROD-01',
      price: 1200,
      stock: 10
    })
  });
  test('Salesman with stockAccess can add products to catalog', () => {
    assert.strictEqual(smStockAddProd.status, 201);
    assert.strictEqual(smStockAddProd.data.product.name, 'Authorized Staff Product');
  });

  // 11. Owner can manually mark paid
  const ownerMarkPaidRes = await req(`/api/orders/${createdOrderRef}/mark-paid`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ utr: 'MANUAL-UTR-CONFIRMED', paymentMethod: 'Direct Cash' })
  });
  test('Store Owner can manually mark order as paid', () => {
    assert.strictEqual(ownerMarkPaidRes.status, 200);
    assert.strictEqual(ownerMarkPaidRes.data.order.status, 'PAID');
    assert.strictEqual(ownerMarkPaidRes.data.order.utr, 'MANUAL-UTR-CONFIRMED');
  });

  console.log(`\n========================================`);
  console.log(`Final Result: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`========================================\n`);

  if (passed === total) {
    console.log('🎉 ALL STRONG ACCESS SEPARATION TESTS PASSED WITH 100% SUCCESS!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
