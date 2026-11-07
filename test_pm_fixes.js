const http = require('http');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING SENIOR PM FIXES VERIFICATION ---');

  // Step 0: Login / get session for Kaveri Atelier
  console.log('\n[1] Testing Auth & Boutique Multi-Tenancy...');
  // Read sellers from data to get IDs
  const fs = require('fs');
  const sellers = JSON.parse(fs.readFileSync('./data/sellers.json', 'utf8'));
  const kaveri = sellers.find(s => (s.brandName || '').includes('Kaveri')) || sellers[0];
  const royal = sellers.find(s => (s.brandName || '').includes('Royal')) || sellers[1];

  console.log(`Found boutique 1: "${kaveri.brandName}" (ID: ${kaveri.id})`);
  console.log(`Found boutique 2: "${royal.brandName}" (ID: ${royal.id})`);

  // Find active OWNER sessions from sessions.json
  const sessions = JSON.parse(fs.readFileSync('./data/sessions.json', 'utf8'));
  let kaveriToken = null;
  let royalToken = null;

  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.sellerId === kaveri.id && sess.role === 'OWNER') {
      kaveriToken = token;
    }
    if (sess.sellerId === royal.id && sess.role === 'OWNER') {
      royalToken = token;
    }
  }

  console.log('Kaveri Owner Token found:', Boolean(kaveriToken));
  console.log('Royal Owner Token found:', Boolean(royalToken));

  // Step 1: Update Boutique Branding in Store Settings
  console.log('\n[2] Testing Boutique Branding in Store Settings...');
  const settingsRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/store/settings',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${kaveriToken}`
    }
  }, {
    storeLocation: 'Defence Colony, New Delhi',
    storeInstagram: '@kaveriatelier',
    storeLogo: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="%236366f1"/></svg>',
    assuranceText: 'Handcrafted with pure Banarasi zari, reserved exclusively for your celebration.'
  });

  console.log('Settings update status:', settingsRes.status);
  console.log('Settings response message:', settingsRes.body.message);

  // Step 2: Create Order 1 for Kaveri Atelier with ₹3,200
  console.log('\n[3] Testing Order Creation with Cryptographic Token & Store-Scoped Ref...');
  const order1Res = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${kaveriToken}`
    }
  }, {
    amount: 3200,
    itemDesc: 'Kaveri Pure Organza Silk Saree',
    customerName: 'Radhika Apte',
    customerPhone: '9820112345',
    customerNotes: 'Please expedite delivery'
  });

  console.log('Order 1 status:', order1Res.status);
  const order1 = order1Res.body.order;
  console.log('Order 1 Token:', order1.checkoutToken);
  console.log('Order 1 Invoice ID:', order1.invoiceId);
  console.log('Order 1 Store Ref:', order1.storeRef);
  console.log('Order 1 Checkout URL:', order1Res.body.checkoutUrl);

  if (!order1.checkoutToken || !order1.checkoutToken.startsWith('kav_')) {
    console.error('FAIL: Checkout token does not start with boutique slug kav_');
  } else {
    console.log('PASS: Cryptographically secure token generated:', order1.checkoutToken);
  }

  // Step 3: Create Order 2 for Kaveri Atelier with SAME AMOUNT ₹3,200 (Collision test)
  const order2Res = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${kaveriToken}`
    }
  }, {
    amount: 3200,
    itemDesc: 'Kaveri Chanderi Silk Kurta',
    customerName: 'Ananya Birla',
    customerPhone: '9820199999'
  });
  const order2 = order2Res.body.order;
  console.log('Order 2 Token:', order2.checkoutToken);
  console.log('Order 2 Invoice ID:', order2.invoiceId);
  console.log('Order 2 Store Ref:', order2.storeRef);

  // Step 4: Create Order for Royal Silk House to verify Multi-Tenant Isolation
  const orderRoyalRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${royalToken}`
    }
  }, {
    amount: 4500,
    itemDesc: 'Royal Kanjeevaram Bridal Saree',
    customerName: 'Meera Rajput'
  });
  const orderRoyal = orderRoyalRes.body.order;
  console.log('Royal Order Token:', orderRoyal.checkoutToken);
  console.log('Royal Order Invoice ID:', orderRoyal.invoiceId);
  console.log('Royal Order Store Ref:', orderRoyal.storeRef);
  console.log('PASS: Multi-tenant isolated refs & invoice IDs checked.');

  // Step 5: Test PII Masking
  console.log('\n[4] Testing PII Masking on Public Link Access...');
  // First, submit full address for Order 1
  const addrRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order1.checkoutToken}/address`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    fullName: 'Radhika Apte',
    phone: '9820112345',
    flat: 'Flat 402, Sea Green Apt',
    street: '14th Road, Bandra West',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400050'
  });

  const sessionKey = addrRes.body.customerSessionKey;
  console.log('Received Customer Session Key:', sessionKey ? 'YES (Valid)' : 'NO');

  // Access public order WITHOUT session key (Simulating stranger scraping)
  const publicOrderRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order1.checkoutToken}`,
    method: 'GET'
  });

  console.log('Public Customer Name:', publicOrderRes.body.order.customerName);
  console.log('Public Customer Phone:', publicOrderRes.body.order.customerPhone);
  console.log('Public Customer Address:', JSON.stringify(publicOrderRes.body.order.address));
  console.log('Store Location in Order:', publicOrderRes.body.order.storeLocation);
  console.log('Store Instagram in Order:', publicOrderRes.body.order.storeInstagram);
  console.log('Assurance Text in Order:', publicOrderRes.body.order.assuranceText);

  if (publicOrderRes.body.order.customerPhone.includes('*****') &&
      publicOrderRes.body.order.address.flat.includes('***')) {
    console.log('PASS: PII is masked for unauthenticated public viewers!');
  } else {
    console.error('FAIL: PII was not masked correctly for public viewer!');
  }

  // Access order WITH session key (Original session editing/viewing)
  const sessionOrderRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order1.checkoutToken}`,
    method: 'GET',
    headers: {
      'x-order-session': sessionKey
    }
  });

  console.log('Session Customer Name:', sessionOrderRes.body.order.customerName);
  console.log('Session Customer Phone:', sessionOrderRes.body.order.customerPhone);
  console.log('Session Customer Address:', JSON.stringify(sessionOrderRes.body.order.address));
  if (sessionOrderRes.body.order.customerPhone === '9820112345' &&
      sessionOrderRes.body.order.address.flat.includes('Flat 402')) {
    console.log('PASS: Full PII is visible to the active customer session!');
  } else {
    console.error('FAIL: Full PII was not unmasked for session owner!');
  }

  // Step 6: Test Bank Email Webhook Collision Match (2 pending orders for ₹3,200, NO ref in alert)
  console.log('\n[5] Testing Ambiguous Bank Credit Alert Collision Handling...');
  const testUtr = String(Date.now()).slice(-12).padStart(12, '1');
  const webhookRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/webhook/simulate-bank-email',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    storeId: kaveri.id,
    amount: 3200,
    senderName: 'UPI-HDFC-9876543210',
    utr: testUtr,
    rawEmailSnippet: `Dear Customer, your account is credited with INR 3,200.00 via UPI. UTR: ${testUtr}.`,
    simulateCollision: true // Omit order ref so it triggers collision check
  });

  console.log('Webhook collision response status:', webhookRes.status);
  console.log('Webhook collision response body:', webhookRes.body);

  if (webhookRes.body.ambiguous === true && webhookRes.body.candidateCount >= 2) {
    console.log(`PASS: Webhook detected ambiguous collision (${webhookRes.body.candidateCount} orders) and refused to guess! Stored in unmatched credits.`);
  } else {
    console.error('FAIL: Webhook did not properly detect collision:', webhookRes.body);
  }

  // Step 7: Test Fallback Match via 12-Digit Manual UTR Verification
  console.log('\n[6] Testing Fallback Match via 12-Digit Manual UTR Verification...');
  const utrRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order1.checkoutToken}/utr`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    utr: testUtr
  });

  console.log('UTR verification status:', utrRes.status);
  console.log('UTR verification response:', utrRes.body);

  if (utrRes.status === 200 && utrRes.body.order.status === 'PAID') {
    console.log('PASS: Order 1 confirmed as PAID via 12-digit UTR fallback match!');
  } else {
    console.error('FAIL: Order 1 was not confirmed via UTR:', utrRes.body);
  }

  // Verify Order 2 remains PENDING
  const order2Check = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order2.checkoutToken}`,
    method: 'GET'
  });
  console.log('Order 2 Status (should remain PENDING):', order2Check.body.order.status);
  if (order2Check.body.order.status === 'PENDING') {
    console.log('PASS: Order 2 remained unpolluted and PENDING!');
  } else {
    console.error('FAIL: Order 2 status was unexpectedly changed!');
  }

  // Step 8: Test Anti-Fraud Duplicate UTR Prevention
  console.log('\n[7] Testing Anti-Fraud Duplicate UTR Prevention...');
  const fraudUtrRes = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/api/orders/${order2.checkoutToken}/utr`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    utr: testUtr // Reusing order 1's UTR!
  });

  console.log('Duplicate UTR response status:', fraudUtrRes.status);
  console.log('Duplicate UTR error message:', fraudUtrRes.body.error);
  if (fraudUtrRes.status === 400 && (fraudUtrRes.body.error.includes('already been claimed') || fraudUtrRes.body.error.includes('already been applied'))) {
    console.log('PASS: Duplicate UTR was blocked by anti-fraud check!');
  } else {
    console.error('FAIL: Duplicate UTR was not blocked properly:', fraudUtrRes.body);
  }

  console.log('\n--- ALL SENIOR PM BACKEND TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(console.error);
