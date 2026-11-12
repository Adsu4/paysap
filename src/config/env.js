const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

const ENCRYPTION_KEY = deriveKey(ENCRYPTION_SECRET);

function encryptSecret(plainText, secretKey = ENCRYPTION_KEY) {
  if (!plainText) return '';
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('Encryption error:', err);
    throw new Error('Could not encrypt credentials.');
  }
}

function decryptSecret(cipherText, secretKey = ENCRYPTION_KEY) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith('enc:')) return cipherText;
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 4) return cipherText;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err);
    return '';
  }
}

function reencryptSecretWithKey(cipherText, oldSecret, newSecret) {
  if (!cipherText || typeof cipherText !== 'string') return cipherText;
  const oldKey = deriveKey(oldSecret);
  const newKey = deriveKey(newSecret);
  const plain = cipherText.startsWith('enc:') ? decryptSecret(cipherText, oldKey) : cipherText;
  if (cipherText.startsWith('enc:') && !plain) {
    throw new Error('Failed to decrypt existing secret with the provided old key.');
  }
  return plain ? encryptSecret(plain, newKey) : '';
}

const BANK_PRESETS = {
  ICICI: {
    code: 'ICICI',
    name: 'ICICI Bank',
    verifiedSender: 'bankingalerts@icicibank.com',
    allowedDomains: ['icicibank.com', 'icicibank.net']
  },
  HDFC: {
    code: 'HDFC',
    name: 'HDFC Bank',
    verifiedSender: 'alerts@hdfcbank.net',
    allowedDomains: ['hdfcbank.net', 'hdfcbank.com']
  },
  SBI: {
    code: 'SBI',
    name: 'State Bank of India (SBI)',
    verifiedSender: 'sbialerts@sbi.co.in',
    allowedDomains: ['sbi.co.in']
  },
  AXIS: {
    code: 'AXIS',
    name: 'Axis Bank',
    verifiedSender: 'alerts@axisbank.com',
    allowedDomains: ['axisbank.com']
  },
  KOTAK: {
    code: 'KOTAK',
    name: 'Kotak Mahindra Bank',
    verifiedSender: 'alerts@kotak.com',
    allowedDomains: ['kotak.com']
  },
  PNB: {
    code: 'PNB',
    name: 'Punjab National Bank (PNB)',
    verifiedSender: 'alerts@pnb.co.in',
    allowedDomains: ['pnb.co.in']
  },
  BOB: {
    code: 'BOB',
    name: 'Bank of Baroda',
    verifiedSender: 'alerts@bankofbaroda.com',
    allowedDomains: ['bankofbaroda.com']
  },
  FEDERAL: {
    code: 'FEDERAL',
    name: 'Federal Bank',
    verifiedSender: 'fednetinfo@federalbank.co.in',
    allowedDomains: ['federalbank.co.in']
  },
  CUSTOM: {
    code: 'CUSTOM',
    name: 'Other Bank (Custom Email)',
    verifiedSender: '',
    allowedDomains: []
  }
};

const PINCODE_CACHE = {
  '560038': { city: 'Bengaluru', state: 'Karnataka', area: 'Indiranagar' },
  '560001': { city: 'Bengaluru', state: 'Karnataka', area: 'MG Road / Bangalore GPO' },
  '560034': { city: 'Bengaluru', state: 'Karnataka', area: 'Koramangala' },
  '400050': { city: 'Mumbai', state: 'Maharashtra', area: 'Bandra West' },
  '400001': { city: 'Mumbai', state: 'Maharashtra', area: 'Fort / Mumbai GPO' },
  '400053': { city: 'Mumbai', state: 'Maharashtra', area: 'Andheri West' },
  '110001': { city: 'New Delhi', state: 'Delhi', area: 'Connaught Place' },
  '110016': { city: 'New Delhi', state: 'Delhi', area: 'Hauz Khas' },
  '122002': { city: 'Gurugram', state: 'Haryana', area: 'DLF Phase 1 / Cyber City' },
  '201301': { city: 'Noida', state: 'Uttar Pradesh', area: 'Sector 15 / Atta' },
  '600028': { city: 'Chennai', state: 'Tamil Nadu', area: 'R.A. Puram' },
  '500034': { city: 'Hyderabad', state: 'Telangana', area: 'Banjara Hills' },
  '700019': { city: 'Kolkata', state: 'West Bengal', area: 'Ballygunge' },
  '302001': { city: 'Jaipur', state: 'Rajasthan', area: 'Jaipur GPO' },
  '411004': { city: 'Pune', state: 'Maharashtra', area: 'Deccan Gymkhana' },
  '682001': { city: 'Kochi', state: 'Kerala', area: 'Fort Kochi' },
  '380009': { city: 'Ahmedabad', state: 'Gujarat', area: 'Navrangpura' }
};

function isAllowedImapEndpoint(host = 'imap.gmail.com', port = 993) {
  const allowed = (process.env.ALLOWED_IMAP_HOSTS || 'imap.gmail.com,outlook.office365.com,imap.mail.yahoo.com')
    .split(',')
    .map(value => value.trim().toLowerCase());
  return typeof host === 'string' && allowed.includes(host.toLowerCase()) && Number(port) === 993;
}

function getGoogleOAuthRedirectUri(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || '127.0.0.1:3000';
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  return `${proto}://${host}/api/auth/google/callback`;
}

function isPostgresEnabled() {
  if (process.env.STORAGE_DRIVER === 'json') return false;
  if (process.env.STORAGE_DRIVER === 'postgres') return true;
  return Boolean(process.env.DATABASE_URL);
}

function validateProductionEnvironment() {
  if (process.env.NODE_ENV !== 'production') return;
  for (const name of ['ENCRYPTION_KEY', 'WEBHOOK_SHARED_SECRET']) {
    const value = process.env[name] || '';
    if (value.length < 32 || /^(012345|your[_-]|super[_-]?secret)|replace[_-]?in[_-]?production/i.test(value)) {
      throw new Error(`${name} must be configured with a unique random secret of at least 32 characters.`);
    }
  }
  let url;
  try { url = new URL(process.env.APP_URL); } catch (_) { throw new Error('APP_URL must be an absolute application URL.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('APP_URL must be the HTTPS application origin (HTTP is allowed only for local tests).');
  }
  if (!isPostgresEnabled() && require('cluster').isWorker) {
    throw new Error('JSON persistence requires a single application process. Cluster mode is disabled.');
  }
}

module.exports = {
  DATA_DIR,
  BANK_PRESETS,
  PINCODE_CACHE,
  deriveKey,
  encryptSecret,
  decryptSecret,
  reencryptSecretWithKey,
  isAllowedImapEndpoint,
  getGoogleOAuthRedirectUri,
  isPostgresEnabled,
  validateProductionEnvironment
};

