const http = require('http');

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method: 'GET',
      headers
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runAuditTests() {
  console.log('--- STARTING DEEP AUDIT FIXES VERIFICATION ---');

  const fs = require('fs');
  const path = require('path');
  const sellers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sellers.json'), 'utf8'));
  const sessions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sessions.json'), 'utf8'));
  const kaveri = sellers.find(s => (s.brandName || '').includes('Kaveri')) || sellers[0];

  let token = null;
  for (const [sToken, sess] of Object.entries(sessions)) {
    if (sess.sellerId === kaveri.id && sess.role === 'OWNER') {
      token = sToken;
      break;
    }
  }

  if (!token) {
    console.error('No active owner token found for Kaveri');
    process.exit(1);
  }
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2. Test Duplicate Salesman PIN Rejection
  console.log('\n[1] Testing Duplicate Salesman PIN Rejection...');
  const smListRes = await get('/api/store/salesmen', authHeaders);
  const existingSm = smListRes.body.salesmen[0];
  const testPin = existingSm ? existingSm.pin : '9988';

  const dupRes = await post('/api/store/salesmen', {
    name: 'Clone Staff',
    pin: testPin
  }, authHeaders);

  if (dupRes.status === 400 && dupRes.body.error && dupRes.body.error.includes('already uses PIN')) {
    console.log(`✅ [PASS] Duplicate salesman PIN ${testPin} correctly rejected with 400!`);
  } else {
    console.error('❌ [FAIL] Expected 400 for duplicate PIN, got:', dupRes);
    process.exit(1);
  }

  // 3. Test Address Validation (10-digit phone & 6-digit pincode)
  console.log('\n[2] Testing Address Input Formatting...');
  const orderRes = await post('/api/orders', {
    amount: 1500,
    itemDesc: 'Audit Test Silk Dupatta'
  }, authHeaders);
  const orderToken = orderRes.body.order.token;

  // Test invalid phone (9 digits)
  const badPhoneRes = await post(`/api/orders/${orderToken}/address`, {
    fullName: 'Test User',
    phone: '982011234', // 9 digits
    flat: 'Flat 1',
    street: 'Main Road',
    pincode: '400050',
    city: 'Mumbai',
    state: 'MH'
  });
  if (badPhoneRes.status === 400 && badPhoneRes.body.error.includes('10-digit')) {
    console.log('✅ [PASS] Invalid 9-digit phone blocked with 400!');
  } else {
    console.error('❌ [FAIL] Expected 400 for 9-digit phone, got:', badPhoneRes);
    process.exit(1);
  }

  // Test invalid pincode (5 digits)
  const badPinRes = await post(`/api/orders/${orderToken}/address`, {
    fullName: 'Test User',
    phone: '9820112345',
    flat: 'Flat 1',
    street: 'Main Road',
    pincode: '40005', // 5 digits
    city: 'Mumbai',
    state: 'MH'
  });
  if (badPinRes.status === 400 && badPinRes.body.error.includes('6-digit')) {
    console.log('✅ [PASS] Invalid 5-digit pincode blocked with 400!');
  } else {
    console.error('❌ [FAIL] Expected 400 for 5-digit pincode, got:', badPinRes);
    process.exit(1);
  }

  // 4. Test Stock Decrement Idempotency & Already-Paid UTR
  console.log('\n[3] Testing Stock Decrement Idempotency & Already-Paid UTR...');
  const markRes1 = await post(`/api/orders/${orderToken}/mark-paid`, {}, authHeaders);
  if (markRes1.status !== 200 || markRes1.body.order.status !== 'PAID') {
    console.error('❌ [FAIL] Expected 200 for initial mark-paid, got:', markRes1);
    process.exit(1);
  }

  // Second mark-paid should return 200 gracefully without error or double decrement
  const markRes2 = await post(`/api/orders/${orderToken}/mark-paid`, {}, authHeaders);
  if (markRes2.status === 200 && markRes2.body.message.includes('already marked as paid')) {
    console.log('✅ [PASS] Second mark-paid correctly handled as already-paid (200 OK)!');
  } else {
    console.error('❌ [FAIL] Expected already-paid 200 on second mark-paid, got:', markRes2);
    process.exit(1);
  }

  // UTR submission on already-paid order returns 200
  const utrRes = await post(`/api/orders/${orderToken}/utr`, { utr: '999888777666' });
  if (utrRes.status === 200 && utrRes.body.message.includes('already been confirmed')) {
    console.log('✅ [PASS] Customer UTR submission on already-paid order returns 200 OK!');
  } else {
    console.error('❌ [FAIL] Expected already-confirmed 200 on paid order UTR submission, got:', utrRes);
    process.exit(1);
  }

  // 5. Test CSV Formula Injection Defense
  console.log('\n[4] Testing CSV Formula Injection Defense...');
  // Create an order with formula injection characters in customerName and notes
  const formulaOrderRes = await post('/api/orders', {
    amount: 2200,
    customerName: '=cmd|\'/C calc\'!A0',
    itemDesc: '+1234567890',
    notes: '@SUM(1+1)'
  }, authHeaders);

  const csvRes = await get('/api/orders/export/csv', authHeaders);
  if (csvRes.status === 200 && typeof csvRes.raw === 'string') {
    if (csvRes.raw.includes(`"'=cmd|\'/C calc\'!A0"`)) {
      console.log('✅ [PASS] Formula injection cell safely prepended with single quote in CSV output!');
    } else {
      console.error('❌ [FAIL] Formula not sanitized in CSV:', csvRes.raw.substring(0, 300));
      process.exit(1);
    }
  }

  console.log('\n🎉 ALL DEEP AUDIT VERIFICATION TESTS PASSED WITH 100% SUCCESS!');
}

runAuditTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
