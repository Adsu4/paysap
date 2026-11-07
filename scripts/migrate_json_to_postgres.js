// PaySap • Automated Migration Script: Flat JSON -> PostgreSQL
// Run: node scripts/migrate_json_to_postgres.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SELLERS_FILE = path.join(DATA_DIR, 'sellers.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const UNMATCHED_FILE = path.join(DATA_DIR, 'unmatched_credits.json');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL is not defined in .env');
  console.error('👉 Example: DATABASE_URL="postgresql://user:password@ep-cool-fog.neon.tech/paysap?sslmode=require"');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function load(file, fallback = []) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn(`Could not parse ${file}:`, e.message);
    }
  }
  return fallback;
}

async function runMigration() {
  const client = await pool.connect();
  console.log('🚀 Connected to PostgreSQL database.');

  try {
    await client.query('BEGIN');

    // 1. Migrate Sellers & Salesmen
    const sellers = load(SELLERS_FILE);
    console.log(`📦 Migrating ${sellers.length} sellers...`);

    for (const s of sellers) {
      await client.query(`
        INSERT INTO sellers (
          id, email, password_hash, salt, brand_name, owner_name, brand_category,
          phone, upi_id, store_location, store_instagram, store_logo, assurance_text, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          brand_name = EXCLUDED.brand_name,
          phone = EXCLUDED.phone,
          upi_id = EXCLUDED.upi_id,
          store_location = EXCLUDED.store_location,
          store_instagram = EXCLUDED.store_instagram,
          store_logo = EXCLUDED.store_logo;
      `, [
        s.id,
        s.email || `${s.id}@paysap.local`,
        s.passwordHash || 'default_hash',
        s.salt || 'default_salt',
        s.brandName || 'Store Name',
        s.ownerName || null,
        s.brandCategory || 'Retail & Goods',
        s.phone || '0000000000',
        s.upiId || 'direct@upi',
        s.storeLocation || null,
        s.storeInstagram || null,
        s.storeLogo || null,
        s.assuranceText || 'Your order is reserved exclusively for you.',
        s.createdAt || new Date().toISOString()
      ]);

      // Banking automation config
      const ba = s.bankingAutomation || {};
      await client.query(`
        INSERT INTO seller_banking_configs (
          seller_id, bank_code, verified_sender_email, encrypted_imap_user,
          encrypted_imap_password, google_connected, google_connected_email, monitoring_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (seller_id) DO UPDATE SET
          bank_code = EXCLUDED.bank_code,
          verified_sender_email = EXCLUDED.verified_sender_email;
      `, [
        s.id,
        ba.bankCode || 'ICICI',
        ba.verifiedSenderEmail || 'bankingalerts@icicibank.com',
        ba.imapUser || null,
        ba.imapAppPassword || null,
        Boolean(ba.googleOAuth && ba.googleOAuth.connected),
        ba.googleOAuth ? ba.googleOAuth.connectedEmail : null,
        ba.monitoringActive !== undefined ? ba.monitoringActive : true
      ]);

      // Salesmen for this store
      if (Array.isArray(s.salesmen)) {
        for (const sm of s.salesmen) {
          await client.query(`
            INSERT INTO salesmen (id, seller_id, name, pin, stock_access, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              pin = EXCLUDED.pin,
              stock_access = EXCLUDED.stock_access;
          `, [
            sm.id,
            s.id,
            sm.name,
            sm.pin,
            Boolean(sm.stockAccess),
            sm.createdAt || new Date().toISOString()
          ]);
        }
      }
    }

    // 2. Migrate Products
    const products = load(PRODUCTS_FILE);
    console.log(`📦 Migrating ${products.length} catalog products...`);
    for (const p of products) {
      await client.query(`
        INSERT INTO products (id, seller_id, name, sku, category, price, stock, low_stock_alert, image_url, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          price = EXCLUDED.price,
          stock = EXCLUDED.stock;
      `, [
        p.id,
        p.sellerId,
        p.name || 'Unnamed Product',
        p.sku || null,
        p.category || 'General',
        parseFloat(p.price || 0),
        parseInt(p.stock || 0, 10),
        parseInt(p.lowStockAlert || 5, 10),
        p.imageUrl || null,
        p.createdAt || new Date().toISOString()
      ]);
    }

    // 3. Migrate Orders
    const orders = load(ORDERS_FILE);
    console.log(`📦 Migrating ${orders.length} orders...`);
    for (const o of orders) {
      await client.query(`
        INSERT INTO orders (
          id, token, ref, store_ref, invoice_id, seller_id, salesman_id, salesman_name,
          product_id, sku, item_description, amount, payable_amount, currency,
          customer_name, customer_phone, customer_session_key, status, payment_method,
          payment_ref, utr, paid_at, dispatch_status, tracking_number, delivery_address,
          order_steps, current_step, verified_via, match_reason, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26, $27, $28, $29, $30
        )
        ON CONFLICT (id) DO NOTHING;
      `, [
        o.id,
        o.token,
        o.ref,
        o.storeRef || o.ref,
        o.invoiceId || `INV-${o.ref}`,
        o.sellerId,
        o.salesmanId || null,
        o.salesmanName || 'Owner / Store Master',
        o.productId || null,
        o.sku || null,
        o.itemDescription || 'Order Item',
        parseFloat(o.amount || 0),
        parseFloat(o.payableAmount || o.amount || 0),
        o.currency || 'INR',
        o.customerName || 'Customer',
        o.customerPhone || '0000000000',
        o.customerSessionKey || null,
        o.status || 'PENDING',
        o.paymentMethod || null,
        o.paymentRef || null,
        o.utr || null,
        o.paidAt || null,
        o.dispatchStatus || 'PENDING',
        o.trackingNumber || null,
        JSON.stringify(o.address || null),
        JSON.stringify(o.steps || {}),
        o.currentStep || 'SHARED',
        o.verifiedVia || null,
        o.matchReason || null,
        o.createdAt || new Date().toISOString()
      ]);
    }

    // 4. Migrate Unmatched Credits
    const credits = load(UNMATCHED_FILE);
    console.log(`📦 Migrating ${credits.length} unmatched credit alerts...`);
    for (const c of credits) {
      await client.query(`
        INSERT INTO unmatched_credits (
          id, seller_id, amount, utr, store_name, raw_text,
          candidate_tokens, candidate_refs, received_at, resolved
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING;
      `, [
        c.id,
        c.sellerId || null,
        parseFloat(c.amount || 0),
        c.utr || '',
        c.storeName || null,
        c.rawText || '',
        c.candidateOrderTokens || [],
        c.candidateOrderRefs || [],
        c.receivedAt || new Date().toISOString(),
        Boolean(c.resolved)
      ]);
    }

    await client.query('COMMIT');
    console.log('🎉 Database migration successfully finished! All tables populated.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
