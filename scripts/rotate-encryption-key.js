// Re-encrypt stored seller banking credentials (IMAP password & Google OAuth tokens)
// Usage: OLD_ENCRYPTION_KEY=... NEW_ENCRYPTION_KEY=... node scripts/rotate-encryption-key.js
require('dotenv').config();
const { reencryptSecretWithKey } = require('../src/config/env');
const { createStore } = require('../src/storage');

async function rotate() {
  const oldKey = process.env.OLD_ENCRYPTION_KEY;
  const newKey = process.env.NEW_ENCRYPTION_KEY;
  if (!oldKey || !newKey || newKey.length < 32) {
    console.error('Set OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY (>= 32 chars).');
    process.exit(1);
  }

  const store = createStore();
  await store.init();
  let rotatedCount = 0;

  try {
    await store.withTransaction(async tx => {
      const sellers = await tx.listSellers();
      for (const seller of sellers) {
        const ba = seller.bankingAutomation;
        if (!ba) continue;
        let changed = false;
        if (ba.imapAppPassword) {
          ba.imapAppPassword = reencryptSecretWithKey(ba.imapAppPassword, oldKey, newKey);
          changed = true;
        }
        if (ba.googleOAuth) {
          if (ba.googleOAuth.refreshToken) {
            ba.googleOAuth.refreshToken = reencryptSecretWithKey(ba.googleOAuth.refreshToken, oldKey, newKey);
            changed = true;
          }
          if (ba.googleOAuth.accessToken) {
            ba.googleOAuth.accessToken = reencryptSecretWithKey(ba.googleOAuth.accessToken, oldKey, newKey);
            changed = true;
          }
        }
        if (changed) {
          await tx.saveSeller(seller);
          rotatedCount++;
        }
      }
    });
    console.log(`Rotated encrypted credentials for ${rotatedCount} store(s).`);
  } finally {
    await store.close();
  }
}

rotate().catch(err => {
  console.error('Key rotation failed:', err.message);
  process.exit(1);
});

