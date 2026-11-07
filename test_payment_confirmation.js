// End-to-End Payment Confirmation Test Suite
const http = require('http');
const fs = require('fs');

const BASE_URL = 'http://127.0.0.1:3000';

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BASE_URL);
    const req = http.request(url, {
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
        } catch (e) {
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
    const url = new URL(path, BASE_URL);
    const req = http.request(url, {
      method: 'GET',
      headers
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('=== PAYMENT CONFIRMATION VERIFICATION SUITE ===\n');

  // Find Achu India PVT LTD seller
  const sellers = JSON.parse(fs.readFileSync('data/sellers.json', 'utf8'));
  const achuSeller = sellers.find(s => s.brandName && s.brandName.includes('Achu'));
  if (!achuSeller) throw new Error('Achu seller not found');

  const sessions = JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
  const achuToken = Object.keys(sessions).find(k => sessions[k].sellerId === achuSeller.id && sessions[k].role === 'OWNER');
  const authHeaders = { 'Authorization': `Bearer ${achuToken}` };

  // 1. Create a fresh order for testing payment confirmation
  console.log('[1] Creating test order for Achu India PVT LTD...');
  const createRes = await post('/api/orders', {
    customerName: 'Kavita Krishnamurthy',
    customerPhone: '9841098765',
    itemDescription: 'Fine Silver Ankh Pendant',
    amount: 1450,
    notes: 'Payment confirmation test'
  }, authHeaders);

  if (createRes.status !== 201 || !createRes.body.order) {
    console.error('❌ [FAIL] Could not create order:', createRes);
    process.exit(1);
  }
  const order = createRes.body.order;
  console.log(`✅ [PASS] Order created: Token=${order.token}, Ref=${order.ref}, Invoice=${order.invoiceId}`);

  // 2. Test Case-Insensitive & Multi-Identifier Route Matching
  console.log('\n[2] Testing case-insensitive route matching for Address & UTR...');
  
  // Submit address using lowercase ref
  const lowerRef = order.ref.toLowerCase(); // e.g. ach-087
  const addrRes = await post(`/api/orders/${lowerRef}/address`, {
    fullName: 'Kavita Krishnamurthy',
    phone: '9841098765',
    flat: 'Flat 5B, Silver Heights',
    street: 'Kottayam Road',
    pincode: '686001',
    city: 'Kottayam',
    state: 'Kerala'
  });

  if (addrRes.status === 200 && addrRes.body.success) {
    console.log(`✅ [PASS] Address successfully saved via lowercase ref "${lowerRef}"!`);
  } else {
    console.error('❌ [FAIL] Address save failed with lowercase ref:', addrRes);
    process.exit(1);
  }

  // 3. Test Customer UTR Payment Confirmation via Invoice ID
  console.log('\n[3] Testing UTR Payment Confirmation using Invoice ID...');
  const testUtr = '98' + Math.floor(1000000000 + Math.random() * 9000000000);
  const utrRes = await post(`/api/orders/${order.invoiceId}/utr`, {
    utr: testUtr
  });

  if (utrRes.status === 200 && utrRes.body.success && utrRes.body.order.status === 'PAID') {
    console.log(`✅ [PASS] Customer UTR confirmed order as PAID via Invoice ID "${order.invoiceId}"! (UTR: ${testUtr})`);
  } else {
    console.error('❌ [FAIL] UTR confirmation failed via invoiceId:', utrRes);
    process.exit(1);
  }

  // 4. Test Second UTR submission returns graceful 200 OK
  console.log('\n[4] Testing idempotency on already confirmed order...');
  const duplicateUtrRes = await post(`/api/orders/${order.token}/utr`, {
    utr: testUtr
  });
  if (duplicateUtrRes.status === 200 && duplicateUtrRes.body.success) {
    console.log('✅ [PASS] Already-paid order returns 200 OK gracefully!');
  } else {
    console.error('❌ [FAIL] Expected 200 OK for already-paid order, got:', duplicateUtrRes);
    process.exit(1);
  }

  // 5. Test Owner Manual Mark-Paid on another pending order
  console.log('\n[5] Testing Owner Manual Mark-Paid with lowercase ref...');
  const order2Res = await post('/api/orders', {
    customerName: 'Sanjay Dutt',
    customerPhone: '9820011223',
    itemDescription: 'Silver Cufflinks',
    amount: 850
  }, authHeaders);
  const order2 = order2Res.body.order;

  const markPaidRes = await post(`/api/orders/${order2.ref.toLowerCase()}/mark-paid`, {
    paymentMethod: 'Direct Bank Settlement (Cash/UPI)'
  }, authHeaders);

  if (markPaidRes.status === 200 && markPaidRes.body.success && markPaidRes.body.order.status === 'PAID') {
    console.log(`✅ [PASS] Owner marked order2 #${order2.ref} as PAID via lowercase ref!`);
  } else {
    console.error('❌ [FAIL] Owner mark-paid failed:', markPaidRes);
    process.exit(1);
  }

  // 6. Test Bank Email Alert Simulation
  console.log('\n[6] Testing Bank Email Webhook Simulation...');
  const order3Res = await post('/api/orders', {
    customerName: 'Anil Kumble',
    customerPhone: '9845012345',
    itemDescription: 'Silver Coin 50g',
    amount: 5200
  }, authHeaders);
  const order3 = order3Res.body.order;

  const simRes = await post('/api/webhook/simulate-bank-email', {
    ref: order3.ref,
    bankName: 'ICICI Bank'
  });

  if (simRes.status === 200 && simRes.body.success) {
    console.log(`✅ [PASS] Bank alert simulation successfully settled order #${order3.ref}!`);
  } else {
    console.error('❌ [FAIL] Simulation failed:', simRes);
    process.exit(1);
  }

  console.log('\n🎉 ALL PAYMENT CONFIRMATION TESTS PASSED WITH 100% SUCCESS!');
}

run().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
