// PaySap • Automated Migration Script: Flat JSON -> PostgreSQL
// Run: node scripts/migrate_json_to_postgres.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PostgresStore } = require('../src/storage/postgresStore');
const { createStaffPin, storeTheme } = require('../src/utils/security');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function load(name, fallback = []) {
  const file = path.join(DATA_DIR, name);
  if (fs.existsSync(file)) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      return text ? JSON.parse(text) : fallback;
    } catch (e) {
      console.warn(`Could not parse ${file}:`, e.message);
    }
  }
  return fallback;
}

async function runMigration() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL is not defined in .env');
    process.exit(1);
  }

  const pgStore = new PostgresStore(DATABASE_URL);
  await pgStore.init();
  console.log('🚀 PostgreSQL schema verified.');

  try {
    await pgStore.withTransaction(async tx => {
      const sellers = load('sellers.json', []);
      console.log(`📦 Migrating ${sellers.length} sellers...`);
      for (const s of sellers) {
        const salesmen = (s.salesmen || []).map(sm => {
          if (sm.pinHash && sm.pinSalt) return sm;
          const hashed = createStaffPin(String(sm.pin || '0000'));
          return { ...sm, ...hashed };
        });
        const sellerRecord = { ...s, ...storeTheme(s), salesmen };
        const existing = await tx.findSellerById(s.id);
        if (existing) await tx.saveSeller(sellerRecord);
        else await tx.createSeller(sellerRecord);
      }

      const products = load('products.json', []);
      console.log(`📦 Migrating ${products.length} products...`);
      for (const p of products) {
        await tx.saveProduct(p);
      }

      const orders = load('orders.json', []);
      console.log(`📦 Migrating ${orders.length} orders...`);
      for (const o of orders) {
        const existing = await tx.findOrderByToken(o.token);
        const amountPaise = o.amountPaise || Math.round(Number(o.payableAmount ?? o.amount ?? 0) * 100) || 100;
        const normalized = { ...o, amountPaise };
        if (existing) await tx.saveOrder(normalized);
        else await tx.createOrder(normalized);
      }

      const credits = load('unmatched_credits.json', []);
      console.log(`📦 Migrating ${credits.length} unmatched credits...`);
      for (const c of credits) {
        await tx.saveUnmatchedCredit(c);
      }

      const oauthConfig = load('oauth_config.json', null);
      if (oauthConfig) {
        await tx.saveOAuthConfig(oauthConfig);
      }
    });
    console.log('🎉 Database migration successfully finished!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await pgStore.close();
  }
}

runMigration();
