// A disposable local workspace. Never reads or modifies the merchant data directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paysap-demo-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATA_DIR: dataDir, DISABLE_BANK_POLLING: '1',
  HOST: '127.0.0.1', PORT: process.env.DEMO_PORT || '3117',
  APP_URL: `http://127.0.0.1:${process.env.DEMO_PORT || '3117'}`,
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  WEBHOOK_SHARED_SECRET: crypto.randomBytes(32).toString('hex'), ENABLE_EMAIL_AUTO_CONFIRMATION: '0'
});
require('../tests/no-external-network.cjs');
const { startServer, stopServer } = require('../server');
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  await stopServer();
  const resolved = path.resolve(dataDir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('paysap-demo-')) throw new Error('Unexpected demo cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
async function main() {
  const server = startServer();
  await once(server, 'listening');
  const base = process.env.APP_URL;
  async function post(route, body, token) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || route);
    return data;
  }
  const owner = await post('/api/auth/register', { email: 'demo@example.test', password: 'DemoOnly-PaySap2026!', brandName: 'The Loom Room', ownerName: 'Demo Owner', phone: '9000000000', upiId: 'demo@invalid', salesmen: [{ name: 'Demo Staff', pin: '4826' }] });
  for (const item of [{ name: 'Everyday linen kurta · Sage · M', sku: 'LIN-SAG-M', price: 1499, stock: 8 }, { name: 'Handwoven cotton stole · Indigo', sku: 'STL-IND', price: 799.5, stock: 3 }, { name: 'Festive silk set · Rose · S', sku: 'SLK-ROS-S', price: 3499, stock: 0 }]) await post('/api/products', item, owner.token);
  const makeOrder = (name, sku, amount, customerName) => post('/api/orders', { customerPhone: '9000000001', customerName, itemDescription: name, sku, amount }, owner.token);
  const first = await makeOrder('Everyday linen kurta · Sage · M', 'LIN-SAG-M', '1499.00', 'Demo Customer');
  const review = await makeOrder('Handwoven cotton stole · Indigo', 'STL-IND', '799.50', 'Review Customer');
  await post(`/api/orders/${review.order.token}/utr`, { utr: '100000000444' });
  const ready = await makeOrder('Everyday linen kurta · Sage · M', 'LIN-SAG-M', '1499.00', 'Packing Customer');
  await post(`/api/orders/${ready.order.token}/address`, { fullName: 'Packing Customer', phone: '9000000001', flat: 'Demo House', street: 'Demo Road', pincode: '560038', city: 'Bengaluru', state: 'Karnataka' });
  await post(`/api/orders/${ready.order.token}/mark-paid`, { paymentMethod: 'Cash' }, owner.token);
  console.log(`Disposable demo: ${base}/auth`);
  console.log('Demo owner: demo@example.test / DemoOnly-PaySap2026!');
  console.log(`Demo checkout: ${base}/pay?token=${first.order.token}`);
}
process.on('SIGINT', () => cleanup().then(() => process.exit(0)));
process.on('SIGTERM', () => cleanup().then(() => process.exit(0)));
main().catch(async error => { console.error(error.message); await cleanup(); process.exitCode = 1; });
