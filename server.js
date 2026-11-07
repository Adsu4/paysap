// PaySap - Multi-Seller Direct UPI Platform with Bank Email Verification
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

// Production Security & Performance Middleware
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

app.use(helmet({
  contentSecurityPolicy: false, // Preserves Google Fonts, Material Symbols, and Tailwind CDN
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? (process.env.APP_URL || 'https://paysap.me') : true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate Limiters to prevent brute force & denial of service
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min window
  max: 60, // 60 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' }
});

const utrLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many UTR verification requests from this IP. Please try again in 10 minutes.' }
});

// Note: /dispatch route is defined at the bottom with other page routes

app.use(express.static(path.join(__dirname, 'public')));

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SELLERS_FILE = path.join(DATA_DIR, 'sellers.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const UNMATCHED_CREDITS_FILE = path.join(DATA_DIR, 'unmatched_credits.json');
const OAUTH_CONFIG_FILE = path.join(DATA_DIR, 'oauth_config.json');

// Helpers for Data Persistence
function loadJSON(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      return content ? JSON.parse(content) : defaultVal;
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return defaultVal;
}

function saveJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 7)}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      // Windows EPERM / EBUSY fallback when target file is momentarily locked by reader or indexer
      fs.writeFileSync(filePath, content, 'utf8');
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    }
  } catch (err) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (directErr) {
      console.error(`Error saving ${filePath}:`, directErr);
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

let sellersStore = loadJSON(SELLERS_FILE, []);
let sessionsStore = loadJSON(SESSIONS_FILE, {});
let ordersStore = loadJSON(ORDERS_FILE, []);
let productsStore = loadJSON(PRODUCTS_FILE, []);
let unmatchedCreditsStore = loadJSON(UNMATCHED_CREDITS_FILE, []);

// ==========================================
// AES-256-GCM CREDENTIAL ENCRYPTION AT REST
// ==========================================
const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || 'paysap_boutique_aes256_super_secret_key_32bytes!';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

function encryptSecret(plainText) {
  if (!plainText) return '';
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('Encryption error:', err);
    return plainText;
  }
}

function decryptSecret(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith('enc:')) return cipherText;
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 4) return cipherText;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err);
    return cipherText;
  }
}

// ==========================================
// HTML/XSS SANITIZATION UTILITY
// ==========================================
function sanitizeInput(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/[<>"'`]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c] || c);
}

// ==========================================
// OFFICIAL BANK DIRECTORY & SENDER PRESETS
// ==========================================
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
  CUSTOM: {
    code: 'CUSTOM',
    name: 'Other Bank (Custom Email)',
    verifiedSender: '',
    allowedDomains: []
  }
};

function isVerifiedBankSender(fromHeader, storeBankingAutomation) {
  if (!fromHeader) return false;
  const cleanFrom = String(fromHeader).toLowerCase();

  // 1. Check store's configured verifiedSenderEmail (supports single, multiple comma-separated, or domains like @mybank.com)
  if (storeBankingAutomation && storeBankingAutomation.verifiedSenderEmail) {
    const rawExpected = storeBankingAutomation.verifiedSenderEmail.toLowerCase().trim();
    if (rawExpected) {
      const parts = rawExpected.split(/[,;]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
      for (const part of parts) {
        if (cleanFrom.includes(part)) {
          return true;
        }
      }
    }
  }

  // 2. Check store's bank preset allowed domains
  const bankCode = (storeBankingAutomation && storeBankingAutomation.bankCode) || '';
  const preset = BANK_PRESETS[bankCode];
  if (preset && preset.allowedDomains && preset.allowedDomains.length > 0) {
    for (const domain of preset.allowedDomains) {
      if (cleanFrom.includes(`@${domain}`) || cleanFrom.includes(`.${domain}`)) {
        return true;
      }
    }
  }

  // 3. Fallback: Check all known Indian bank alert domains
  const allKnownBankDomains = [
    'icicibank.com', 'icicibank.net', 'hdfcbank.net', 'hdfcbank.com',
    'sbi.co.in', 'axisbank.com', 'kotak.com', 'pnb.co.in', 'bankofbaroda.com'
  ];
  for (const domain of allKnownBankDomains) {
    if (cleanFrom.includes(`@${domain}`) || cleanFrom.includes(`.${domain}`)) {
      return true;
    }
  }

  return false;
}

// CRYPTOGRAPHIC CHECKOUT TOKEN GENERATOR
// ==========================================

// Generates a store-branded, URL-safe random token like "kav_8f9a2b7c4d"
function generateCheckoutToken(brandName) {
  const prefix = (brandName || 'ord')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 3)
    .toLowerCase();
  const randomPart = crypto.randomBytes(5).toString('hex'); // 10 hex chars
  return `${prefix}_${randomPart}`;
}

// Generate a store-scoped sequential invoice ID like "INV-2026-089"
function generateInvoiceId(sellerId) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const storeOrders = ordersStore.filter(o => o.sellerId === sellerId);
  let maxSeq = 0;
  for (const o of storeOrders) {
    if (o.invoiceId && o.invoiceId.startsWith(prefix)) {
      const num = parseInt(o.invoiceId.replace(prefix, ''), 10);
      if (num > maxSeq) maxSeq = num;
    }
  }
  let nextNum = Math.max(storeOrders.length + 1, maxSeq + 1);
  let invId = `${prefix}${String(nextNum).padStart(3, '0')}`;
  while (ordersStore.some(o => o.sellerId === sellerId && o.invoiceId === invId)) {
    nextNum++;
    invId = `${prefix}${String(nextNum).padStart(3, '0')}`;
  }
  return invId;
}

// ==========================================
// PII MASKING FOR PUBLIC CHECKOUT ENDPOINTS
// ==========================================

function maskName(name) {
  if (!name || name.length < 2) return name;
  const parts = name.trim().split(' ');
  return parts.map((part, i) => {
    if (i === 0) {
      // First name: show first 4 chars, mask rest
      if (part.length <= 4) return part;
      return part.substring(0, 4) + '*'.repeat(Math.min(part.length - 4, 4));
    }
    // Last name: show first letter + mask
    return part.charAt(0) + '*'.repeat(Math.min(part.length - 1, 4));
  }).join(' ');
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string' || phone.length < 6) return phone || '';
  const clean = phone.replace(/\D/g, '');
  if (clean.length <= 4) return clean;
  return clean.substring(0, 5) + '*'.repeat(clean.length - 5);
}

function maskAddress(address) {
  if (!address) return null;
  let maskedStreet = null;
  if (address.street) {
    const parts = address.street.split(',');
    const locality = parts.length > 1 ? parts[parts.length - 1].trim() : (address.city || address.street.trim());
    maskedStreet = `Flat ***, ${locality}`;
  } else if (address.city) {
    maskedStreet = `Flat ***, ${address.city}`;
  }
  return {
    fullName: maskName(address.fullName),
    phone: maskPhone(address.phone),
    flat: 'Flat ***',
    street: maskedStreet || 'Flat ***',
    landmark: address.landmark ? 'Near ***' : null,
    pincode: address.pincode ? address.pincode.substring(0, 3) + '***' : null,
    city: address.city || null,
    state: address.state || null
  };
}

// Robust order index lookup by cryptographic token, invoiceId, storeRef, or ref
function findOrderIndex(tokenOrRef, sellerId = null) {
  if (!tokenOrRef) return -1;
  const clean = String(tokenOrRef).trim().toLowerCase();
  return ordersStore.findIndex(o => {
    if (sellerId && o.sellerId !== sellerId) return false;
    if (o.token && o.token.toLowerCase() === clean) return true;
    if (o.invoiceId && o.invoiceId.toLowerCase() === clean) return true;
    if (o.ref && String(o.ref).toLowerCase() === clean) return true;
    if (o.storeRef && String(o.storeRef).toLowerCase() === clean) return true;
    if (o.id && String(o.id).toLowerCase() === clean) return true;
    return false;
  });
}

// Find order by cryptographic token, invoiceId, or legacy ref (backward compat)
function findOrderByTokenOrRef(tokenOrRef) {
  const idx = findOrderIndex(tokenOrRef);
  return idx !== -1 ? ordersStore[idx] : null;
}

// Password Hashing with Node crypto (scrypt)
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, originalHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

// Token & Session Helper with Role-Based Scoping
function createSession(sellerId, role = 'OWNER', salesman = null) {
  const token = crypto.randomBytes(32).toString('hex');
  sessionsStore[token] = {
    sellerId,
    role: role || 'OWNER',
    salesmanId: salesman ? salesman.id : null,
    salesmanName: salesman ? salesman.name : null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
  };
  saveJSON(SESSIONS_FILE, sessionsStore);
  return token;
}

function getAuthCookieHeader(token) {
  const isProd = process.env.NODE_ENV === 'production';
  return `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${isProd ? '; Secure' : ''}`;
}

function getSellerByToken(token) {
  if (!token) return null;
  const session = sessionsStore[token];
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    delete sessionsStore[token];
    saveJSON(SESSIONS_FILE, sessionsStore);
    return null;
  }
  const seller = sellersStore.find(s => s.id === session.sellerId);
  if (!seller) return null;

  return {
    ...seller,
    currentRole: session.role || 'OWNER',
    currentSalesmanId: session.salesmanId || null,
    currentSalesmanName: session.salesmanName || null
  };
}

// Extract auth token from Header, Query, or Cookie
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }
  if (req.query && req.query.token) {
    return req.query.token;
  }
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// Auth Middleware
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const seller = getSellerByToken(token);
  if (!seller) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  req.seller = seller;
  req.authToken = token;
  next();
}

// Strict Store Owner Middleware (Restricts sensitive settings & actions to Store Owner)
function requireOwner(req, res, next) {
  requireAuth(req, res, () => {
    if (req.seller.currentRole !== 'OWNER') {
      return res.status(403).json({ error: 'Access denied. Master dashboard owner privileges required.' });
    }
    next();
  });
}

// Strip sensitive owner secrets and staff PINs based on active session role
function sanitizeSellerForRole(seller, role = 'OWNER') {
  if (!seller) return null;
  const safe = { ...seller };
  delete safe.passwordHash;
  delete safe.salt;
  delete safe.currentRole;
  delete safe.currentSalesmanId;
  delete safe.currentSalesmanName;

  if (role === 'SALESMAN') {
    delete safe.bankingAutomation;
    delete safe.salesmen; // Prevent leaking other salesmen's 4-digit PINs
    delete safe.googleOAuth;
  }
  return safe;
}

// Optional Auth Middleware (attaches seller if present)
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    const seller = getSellerByToken(token);
    if (seller) req.seller = seller;
  }
  next();
}


// Ensure every order has structured lifecycle steps
function normalizeOrderSteps(order) {
  if (!order.steps) {
    order.steps = {};
  }
  if (!order.steps.shared) {
    order.steps.shared = { done: true, time: order.createdAt || new Date().toISOString() };
  }
  if (!order.steps.opened) {
    order.steps.opened = { done: false, time: null };
  }
  if (!order.steps.addressEntered) {
    order.steps.addressEntered = { done: Boolean(order.address), time: order.address ? order.createdAt : null };
  }
  if (!order.steps.redirectedToPayment) {
    order.steps.redirectedToPayment = { done: false, time: null, app: null };
  }

  if (order.status === 'PAID') {
    if (!order.steps.paymentConfirmed) {
      order.steps.paymentConfirmed = {
        done: true,
        time: order.paidAt || new Date().toISOString(),
        utr: order.utr || null,
        method: order.paymentMethod || null
      };
    } else {
      order.steps.paymentConfirmed.done = true;
      if (!order.steps.paymentConfirmed.time) order.steps.paymentConfirmed.time = order.paidAt || new Date().toISOString();
      if (!order.steps.paymentConfirmed.utr) order.steps.paymentConfirmed.utr = order.utr || null;
      if (!order.steps.paymentConfirmed.method) order.steps.paymentConfirmed.method = order.paymentMethod || null;
    }

    if (!order.steps.spreadsheetUpdated) {
      order.steps.spreadsheetUpdated = {
        done: true,
        time: order.paidAt || new Date().toISOString(),
        rowNumber: null,
        sheetName: 'Master Sales Sheet'
      };
    } else {
      order.steps.spreadsheetUpdated.done = true;
      if (!order.steps.spreadsheetUpdated.time) order.steps.spreadsheetUpdated.time = order.paidAt || new Date().toISOString();
    }

    if (!order.steps.opened) {
      order.steps.opened = { done: true, time: order.paidAt || order.createdAt || new Date().toISOString() };
    } else {
      order.steps.opened.done = true;
    }

    order.currentStep = 'SPREADSHEET_UPDATED';
  } else {
    if (!order.steps.paymentConfirmed) {
      order.steps.paymentConfirmed = { done: false, time: null, utr: null, method: null };
    }
    if (!order.steps.spreadsheetUpdated) {
      order.steps.spreadsheetUpdated = { done: false, time: null, rowNumber: null, sheetName: 'Master Sales Sheet' };
    }
    if (!order.currentStep) {
      if (order.steps.redirectedToPayment && order.steps.redirectedToPayment.done) {
        order.currentStep = 'REDIRECTED_TO_PAYMENT';
      } else if (order.steps.addressEntered && order.steps.addressEntered.done) {
        order.currentStep = 'ADDRESS_ENTERED';
      } else if (order.steps.opened && order.steps.opened.done) {
        order.currentStep = 'LINK_OPENED';
      } else {
        order.currentStep = 'WAITING_FOR_USER';
      }
    }
  }
  return order;
}


// Exact payable amount without artificial paise offsets
function getUniquePayableAmount(baseAmount) {
  return parseFloat(baseAmount);
}

// Known Indian pincodes cache for instant lookup
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

// ==========================================
// 1. AUTHENTICATION & SELLER MANAGEMENT APIS
// ==========================================

// Public Stores Directory (For Salesman Fast PIN Login selection)
// Only exposes minimal info needed for PIN login - no emails or internal IDs
app.get('/api/public/stores', (req, res) => {
  const publicList = sellersStore.map(s => ({
    id: s.id,
    brandName: s.brandName,
    category: s.brandCategory,
    salesmen: (s.salesmen || []).map(sm => ({
      id: sm.id,
      name: sm.name
    }))
  }));
  res.json({ success: true, stores: publicList });
});

// Register New Store (Store Owner)
app.post('/api/auth/register', authLimiter, (req, res) => {
  const {
    email,
    password,
    brandName,
    ownerName,
    brandCategory = 'Luxury Pret & Festive',
    phone,
    upiId,
    initialSalesmanName = 'Counter Staff'
  } = req.body;

  if (!email || !password || !brandName || !upiId) {
    return res.status(400).json({ error: 'Store email, store password, brand name, and direct UPI ID are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (password.length < 6) {
    return res.status(400).json({ error: 'Store password must be at least 6 characters long.' });
  }

  const cleanUpi = upiId.trim();
  if (!cleanUpi.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid UPI VPA ID (e.g. store@okhdfcbank or yourname@upi).' });
  }

  const existing = sellersStore.find(s => s.email === cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email address already exists. Please sign in.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const storeId = `seller_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Construct initial salesmen list from registration data
  let initialSalesmen = [];
  if (Array.isArray(req.body.salesmen) && req.body.salesmen.length > 0) {
    initialSalesmen = req.body.salesmen.map((sm, idx) => ({
      id: `sm_${Date.now()}_${idx + 1}`,
      name: (sm.name || `Floor Staff ${idx + 1}`).trim(),
      pin: (sm.pin && String(sm.pin).trim().length === 4) ? String(sm.pin).trim() : '1234',
      createdAt: new Date().toISOString()
    }));
  } else {
    initialSalesmen = [
      {
        id: `sm_${Date.now()}_1`,
        name: (initialSalesmanName || ownerName || 'Floor Staff').trim(),
        pin: '1234',
        createdAt: new Date().toISOString()
      }
    ];
  }

  const newSeller = {
    id: storeId,
    email: cleanEmail,
    passwordHash,
    salt,
    brandName: sanitizeInput(brandName.trim()),
    ownerName: sanitizeInput((ownerName || brandName).trim()),
    brandCategory: sanitizeInput(brandCategory.trim()),
    phone: (phone || '').replace(/\D/g, '').slice(-10),
    upiId: cleanUpi,
    brandColor: '#4f46e5',
    createdAt: new Date().toISOString(),
    salesmen: initialSalesmen
  };

  sellersStore.push(newSeller);
  saveJSON(SELLERS_FILE, sellersStore);

  // Issue session token with OWNER role
  const token = createSession(newSeller.id, 'OWNER');

  res.setHeader('Set-Cookie', getAuthCookieHeader(token));

  const safeSeller = { ...newSeller };
  delete safeSeller.passwordHash;
  delete safeSeller.salt;

  res.status(201).json({
    success: true,
    message: 'Store registered successfully on PaySap!',
    token,
    role: 'OWNER',
    seller: safeSeller
  });
});

// Store Owner Login (Requires Store Password)
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Store email/ID and store password are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const seller = sellersStore.find(s => s.email === cleanEmail || s.id === cleanEmail);
  if (!seller) {
    return res.status(401).json({ error: 'Invalid store email or password. Please verify your credentials.' });
  }

  const isValid = verifyPassword(password, seller.salt, seller.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'Incorrect store password. Please try again.' });
  }

  // Create OWNER session
  const token = createSession(seller.id, 'OWNER');
  res.setHeader('Set-Cookie', getAuthCookieHeader(token));

  const safeSeller = sanitizeSellerForRole(seller, 'OWNER');

  res.json({
    success: true,
    message: `Welcome back to ${seller.brandName} Master Dashboard!`,
    token,
    role: 'OWNER',
    seller: safeSeller
  });
});

// Salesman PIN Login (Fast 4-Digit PIN Access)
app.post('/api/auth/salesman-login', authLimiter, (req, res) => {
  const { storeId, salesmanId, pin } = req.body;

  if (!storeId || !pin) {
    return res.status(400).json({ error: 'Please select a store and enter your 4-digit PIN.' });
  }

  const seller = sellersStore.find(s => s.id === storeId || s.email === storeId.toLowerCase());
  if (!seller) {
    return res.status(404).json({ error: 'Store not found. Please select a valid store.' });
  }

  if (!seller.salesmen || seller.salesmen.length === 0) {
    return res.status(400).json({ error: 'No salesmen registered for this store. Please ask the store owner to add your PIN.' });
  }

  // Find salesman by ID or by matching PIN if only 1 salesman or direct match
  let salesman = null;
  if (salesmanId) {
    salesman = seller.salesmen.find(sm => sm.id === salesmanId);
  } else {
    // If not specified by ID, find by PIN
    salesman = seller.salesmen.find(sm => sm.pin === String(pin).trim());
  }

  if (!salesman) {
    return res.status(401).json({ error: 'Salesman not found or invalid PIN.' });
  }

  if (salesman.pin !== String(pin).trim()) {
    return res.status(401).json({ error: 'Incorrect 4-digit PIN for ' + salesman.name });
  }

  // Create SALESMAN session
  const token = createSession(seller.id, 'SALESMAN', salesman);
  res.setHeader('Set-Cookie', getAuthCookieHeader(token));

  // Quarantine owner secrets & other staff PINs from salesman payload
  const safeSeller = sanitizeSellerForRole(seller, 'SALESMAN');

  res.json({
    success: true,
    message: `Logged in as ${salesman.name}!`,
    token,
    role: 'SALESMAN',
    salesman: {
      id: salesman.id,
      name: salesman.name
    },
    seller: safeSeller
  });
});

// Helper to verify if user has Stock / Inventory CRM privileges
function hasStockAccess(seller) {
  if (!seller) return false;
  if (seller.currentRole === 'OWNER') return true;
  if (seller.currentSalesmanId) {
    const sm = (seller.salesmen || []).find(s => s.id === seller.currentSalesmanId);
    return sm ? Boolean(sm.stockAccess) : false;
  }
  return false;
}

// Profile / Active Session Verification
app.get('/api/auth/me', (req, res) => {
  const token = extractToken(req);
  const seller = getSellerByToken(token);
  if (!seller) {
    return res.json({ authenticated: false });
  }

  const role = seller.currentRole || 'OWNER';
  const safeSeller = sanitizeSellerForRole(seller, role);
  const canManageStock = hasStockAccess(seller);

  res.json({
    authenticated: true,
    role,
    stockAccess: canManageStock,
    salesman: seller.currentSalesmanId ? {
      id: seller.currentSalesmanId,
      name: seller.currentSalesmanName,
      stockAccess: canManageStock
    } : null,
    seller: safeSeller
  });
});

// Manage Store Salesmen (Master Dashboard - Owner Only)
app.get('/api/store/salesmen', requireOwner, (req, res) => {
  const store = sellersStore.find(s => s.id === req.seller.id);
  res.json({
    success: true,
    salesmen: (store && store.salesmen) || []
  });
});

app.post('/api/store/salesmen', requireOwner, (req, res) => {
  const { name, pin, stockAccess = false } = req.body;
  if (!name || !pin) {
    return res.status(400).json({ error: 'Salesman name and 4-digit PIN are required.' });
  }

  const cleanPin = String(pin).trim();
  if (cleanPin.length < 4) {
    return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
  }

  const storeIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (storeIndex === -1) return res.status(404).json({ error: 'Store not found.' });

  if (!sellersStore[storeIndex].salesmen) {
    sellersStore[storeIndex].salesmen = [];
  }

  // Prevent identity collisions: ensure PIN is unique within this store
  const existingWithPin = sellersStore[storeIndex].salesmen.find(sm => sm.pin === cleanPin);
  if (existingWithPin) {
    return res.status(400).json({ error: `Another staff member ("${existingWithPin.name}") already uses PIN ${cleanPin}. Please assign a unique 4-digit PIN.` });
  }

  const newSalesman = {
    id: `sm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: sanitizeInput(name.trim()),
    pin: cleanPin,
    stockAccess: Boolean(stockAccess),
    createdAt: new Date().toISOString()
  };

  sellersStore[storeIndex].salesmen.push(newSalesman);
  saveJSON(SELLERS_FILE, sellersStore);

  res.status(201).json({ success: true, salesman: newSalesman });
});

app.put('/api/store/salesmen/:id', requireOwner, (req, res) => {
  const { name, pin, stockAccess } = req.body;
  const storeIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (storeIndex === -1) return res.status(404).json({ error: 'Store not found.' });

  const smList = sellersStore[storeIndex].salesmen || [];
  const smIndex = smList.findIndex(sm => sm.id === req.params.id);
  if (smIndex === -1) return res.status(404).json({ error: 'Salesman not found.' });

  if (name) smList[smIndex].name = sanitizeInput(name.trim());
  if (pin) {
    const cleanPin = String(pin).trim();
    if (cleanPin.length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
    }
    const duplicate = smList.find(sm => sm.id !== req.params.id && sm.pin === cleanPin);
    if (duplicate) {
      return res.status(400).json({ error: `Another staff member ("${duplicate.name}") already uses PIN ${cleanPin}. Please assign a unique 4-digit PIN.` });
    }
    smList[smIndex].pin = cleanPin;
  }
  if (typeof stockAccess === 'boolean') {
    smList[smIndex].stockAccess = stockAccess;
    // Keep active session permissions synchronized immediately
    Object.keys(sessionsStore).forEach(t => {
      if (sessionsStore[t].sellerId === req.seller.id && sessionsStore[t].salesmanId === req.params.id) {
        sessionsStore[t].stockAccess = stockAccess;
      }
    });
    saveJSON(SESSIONS_FILE, sessionsStore);
  }

  saveJSON(SELLERS_FILE, sellersStore);
  res.json({ success: true, salesman: smList[smIndex] });
});

app.delete('/api/store/salesmen/:id', requireOwner, (req, res) => {
  const storeIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (storeIndex === -1) return res.status(404).json({ error: 'Store not found.' });

  sellersStore[storeIndex].salesmen = (sellersStore[storeIndex].salesmen || []).filter(sm => sm.id !== req.params.id);
  saveJSON(SELLERS_FILE, sellersStore);

  // Invalidate any active session tokens for the removed staff member immediately
  let sessionsRevoked = 0;
  Object.keys(sessionsStore).forEach(t => {
    if (sessionsStore[t].sellerId === req.seller.id && sessionsStore[t].salesmanId === req.params.id) {
      delete sessionsStore[t];
      sessionsRevoked++;
    }
  });
  if (sessionsRevoked > 0) {
    saveJSON(SESSIONS_FILE, sessionsStore);
  }

  res.json({ success: true, message: 'Salesman removed successfully.' });
});

// Seller Logout
app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token && sessionsStore[token]) {
    delete sessionsStore[token];
    saveJSON(SESSIONS_FILE, sessionsStore);
  }
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Update Seller Profile (Owner Only)
app.post('/api/auth/profile', requireOwner, (req, res) => {
  const sellerIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (sellerIndex === -1) {
    return res.status(404).json({ error: 'Seller not found.' });
  }

  const { brandName, ownerName, brandCategory, phone, upiId } = req.body;
  if (brandName) sellersStore[sellerIndex].brandName = sanitizeInput(brandName.trim());
  if (ownerName) sellersStore[sellerIndex].ownerName = sanitizeInput(ownerName.trim());
  if (brandCategory) sellersStore[sellerIndex].brandCategory = sanitizeInput(brandCategory.trim());
  if (phone) sellersStore[sellerIndex].phone = phone.replace(/\D/g, '').slice(-10);
  if (upiId && upiId.includes('@')) sellersStore[sellerIndex].upiId = upiId.trim();

  saveJSON(SELLERS_FILE, sellersStore);

  const safeSeller = sanitizeSellerForRole(sellersStore[sellerIndex], 'OWNER');
  res.json({ success: true, seller: safeSeller });
});

// Master Store Settings APIs (Owner Exclusive)
app.get('/api/store/settings', requireOwner, (req, res) => {
  const store = sellersStore.find(s => s.id === req.seller.id);
  if (!store) {
    return res.status(404).json({ error: 'Store not found.' });
  }

  const safeStore = sanitizeSellerForRole(store, 'OWNER');

  res.json({
    success: true,
    settings: {
      brandName: safeStore.brandName,
      ownerName: safeStore.ownerName,
      email: safeStore.email,
      phone: safeStore.phone,
      upiId: safeStore.upiId,
      brandCategory: safeStore.brandCategory,
      brandColor: safeStore.brandColor || '#4f46e5',
      storeLocation: safeStore.storeLocation || '',
      storeInstagram: safeStore.storeInstagram || '',
      storeLogo: safeStore.storeLogo || '',
      assuranceText: safeStore.assuranceText || 'Your item is handcrafted and reserved exclusively for you.',
      employeeCount: (safeStore.salesmen || []).length,
      salesmen: safeStore.salesmen || [],
      bankingAutomation: {
        bankCode: safeStore.bankingAutomation?.bankCode || 'ICICI',
        bankName: safeStore.bankingAutomation?.bankName || 'ICICI Bank',
        verifiedSenderEmail: safeStore.bankingAutomation?.verifiedSenderEmail || 'bankingalerts@icicibank.com',
        imapHost: safeStore.bankingAutomation?.imapHost || 'imap.gmail.com',
        imapPort: safeStore.bankingAutomation?.imapPort || 993,
        imapUser: safeStore.bankingAutomation?.imapUser || safeStore.email || '',
        hasAppPassword: Boolean(safeStore.bankingAutomation?.imapAppPassword),
        monitoringActive: Boolean(safeStore.bankingAutomation?.monitoringActive),
        lastCheckedAt: safeStore.bankingAutomation?.lastCheckedAt || null,
        lastMatchedAt: safeStore.bankingAutomation?.lastMatchedAt || null,
        lastError: safeStore.bankingAutomation?.lastError || null,
        googleOAuth: {
          connected: Boolean(safeStore.bankingAutomation?.googleOAuth?.connected),
          connectedEmail: safeStore.bankingAutomation?.googleOAuth?.connectedEmail || null,
          connectedAt: safeStore.bankingAutomation?.googleOAuth?.connectedAt || null
        },
        hasGoogleCredentials: Boolean(getGoogleCredentials().clientId)
      }
    }
  });
});

app.put('/api/store/settings', requireOwner, (req, res) => {
  if (req.seller.currentRole !== 'OWNER') {
    return res.status(403).json({ error: 'Access denied. Master dashboard owner privileges required.' });
  }

  const storeIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (storeIndex === -1) {
    return res.status(404).json({ error: 'Store not found.' });
  }

  const { brandName, ownerName, brandCategory, phone, upiId, currentPassword, newPassword,
          storeLocation, storeInstagram, storeLogo, assuranceText, bankingAutomation } = req.body;

  if (storeLogo !== undefined) {
    const trimmedLogo = (storeLogo || '').trim();
    if (trimmedLogo && (/^(javascript|vbscript|data:(?!image))/i.test(trimmedLogo) || /<script/i.test(trimmedLogo))) {
      return res.status(400).json({ error: 'Invalid or unsafe image URL.' });
    }
    sellersStore[storeIndex].storeLogo = trimmedLogo;
  }

  if (brandName) sellersStore[storeIndex].brandName = sanitizeInput(brandName.trim());
  if (ownerName) sellersStore[storeIndex].ownerName = sanitizeInput(ownerName.trim());
  if (brandCategory) sellersStore[storeIndex].brandCategory = sanitizeInput(brandCategory.trim());
  if (phone) sellersStore[storeIndex].phone = phone.replace(/\D/g, '').slice(-10);
  if (upiId && upiId.includes('@')) sellersStore[storeIndex].upiId = upiId.trim();
  if (storeLocation !== undefined) sellersStore[storeIndex].storeLocation = sanitizeInput((storeLocation || '').trim());
  if (storeInstagram !== undefined) sellersStore[storeIndex].storeInstagram = sanitizeInput((storeInstagram || '').trim().replace(/^@/, ''));
  if (assuranceText !== undefined) sellersStore[storeIndex].assuranceText = sanitizeInput((assuranceText || '').trim());

  // Handle Bank Credit Email Automation Settings
  if (bankingAutomation && typeof bankingAutomation === 'object') {
    if (!sellersStore[storeIndex].bankingAutomation) {
      sellersStore[storeIndex].bankingAutomation = {};
    }
    const ba = sellersStore[storeIndex].bankingAutomation;
    if (bankingAutomation.bankCode !== undefined) ba.bankCode = bankingAutomation.bankCode;
    if (bankingAutomation.bankName !== undefined) ba.bankName = bankingAutomation.bankName;
    if (bankingAutomation.verifiedSenderEmail !== undefined) ba.verifiedSenderEmail = (bankingAutomation.verifiedSenderEmail || '').trim().toLowerCase();
    if (bankingAutomation.imapHost !== undefined) ba.imapHost = (bankingAutomation.imapHost || 'imap.gmail.com').trim();
    if (bankingAutomation.imapPort !== undefined) ba.imapPort = parseInt(bankingAutomation.imapPort, 10) || 993;
    if (bankingAutomation.imapUser !== undefined) ba.imapUser = (bankingAutomation.imapUser || '').trim();
    if (bankingAutomation.imapAppPassword !== undefined && bankingAutomation.imapAppPassword.trim()) {
      ba.imapAppPassword = encryptSecret(bankingAutomation.imapAppPassword.trim());
    }
    if (bankingAutomation.monitoringActive !== undefined) ba.monitoringActive = Boolean(bankingAutomation.monitoringActive);
  }

  // Handle password update if requested - REQUIRES current password verification
  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required to set a new password.' });
    }
    const isCurrentValid = verifyPassword(currentPassword, sellersStore[storeIndex].salt, sellersStore[storeIndex].passwordHash);
    if (!isCurrentValid) {
      return res.status(403).json({ error: 'Current password is incorrect. Password change denied.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    sellersStore[storeIndex].salt = newSalt;
    sellersStore[storeIndex].passwordHash = hashPassword(newPassword, newSalt);
  }

  saveJSON(SELLERS_FILE, sellersStore);

  const safeStore = sanitizeSellerForRole(sellersStore[storeIndex], 'OWNER');
  const safeSettings = {
    brandName: safeStore.brandName,
    ownerName: safeStore.ownerName,
    email: safeStore.email,
    phone: safeStore.phone,
    upiId: safeStore.upiId,
    brandCategory: safeStore.brandCategory,
    brandColor: safeStore.brandColor || '#4f46e5',
    storeLocation: safeStore.storeLocation || '',
    storeInstagram: safeStore.storeInstagram || '',
    storeLogo: safeStore.storeLogo || '',
    assuranceText: safeStore.assuranceText || 'Your item is handcrafted and reserved exclusively for you.',
    employeeCount: (safeStore.salesmen || []).length,
    salesmen: safeStore.salesmen || [],
    bankingAutomation: {
      bankCode: safeStore.bankingAutomation?.bankCode || 'ICICI',
      bankName: safeStore.bankingAutomation?.bankName || 'ICICI Bank',
      verifiedSenderEmail: safeStore.bankingAutomation?.verifiedSenderEmail || 'bankingalerts@icicibank.com',
      imapHost: safeStore.bankingAutomation?.imapHost || 'imap.gmail.com',
      imapPort: safeStore.bankingAutomation?.imapPort || 993,
      imapUser: safeStore.bankingAutomation?.imapUser || safeStore.email || '',
      hasAppPassword: Boolean(safeStore.bankingAutomation?.imapAppPassword),
      monitoringActive: Boolean(safeStore.bankingAutomation?.monitoringActive),
      lastCheckedAt: safeStore.bankingAutomation?.lastCheckedAt || null,
      lastMatchedAt: safeStore.bankingAutomation?.lastMatchedAt || null,
      lastError: safeStore.bankingAutomation?.lastError || null,
      googleOAuth: {
        connected: Boolean(safeStore.bankingAutomation?.googleOAuth?.connected),
        connectedEmail: safeStore.bankingAutomation?.googleOAuth?.connectedEmail || null,
        connectedAt: safeStore.bankingAutomation?.googleOAuth?.connectedAt || null
      },
      hasGoogleCredentials: Boolean(getGoogleCredentials().clientId)
    }
  };

  res.json({
    success: true,
    message: 'Store settings updated successfully.',
    settings: safeSettings
  });
});

// ==========================================
// 1b. PRODUCT CATALOG & SKU DATABASE APIS
// ==========================================

// Fetch Product Catalog (Seller-scoped + Standard Catalog Items)
app.get('/api/products', optionalAuth, (req, res) => {
  const sellerId = req.seller ? req.seller.id : null;
  const { search } = req.query;

  let list = productsStore.filter(p => p.sellerId === 'ALL' || (sellerId && p.sellerId === sellerId));

  if (search) {
    const q = search.toLowerCase().trim();
    list = list.filter(p => 
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q))
    );
  }

  res.json({ success: true, products: list });
});

// Lookup single product by SKU or ID
app.get('/api/products/:identifier', optionalAuth, (req, res) => {
  const ident = req.params.identifier.toLowerCase().trim();
  const sellerId = req.seller ? req.seller.id : null;
  const product = productsStore.find(p => 
    (!sellerId || p.sellerId === 'ALL' || p.sellerId === sellerId) &&
    ((p.sku && p.sku.toLowerCase() === ident) ||
     (p.id && p.id.toLowerCase() === ident) ||
     (p.name && p.name.toLowerCase() === ident))
  );

  if (!product) {
    return res.status(404).json({ error: 'Product not found in database.' });
  }

  res.json({ success: true, product });
});

// Add new Product / SKU to Catalog (Requires Owner or staff with stockAccess)
app.post('/api/products', requireAuth, (req, res) => {
  if (!hasStockAccess(req.seller)) {
    return res.status(403).json({ error: 'Access denied. Stock CRM management permission required. Contact store owner.' });
  }

  const { name, sku, price, stock = 1, description, notes = '', category, image, imageUrl } = req.body;
  if (!name || !price) {
    return res.status(400).json({ error: 'Product Name and Price are required.' });
  }

  const generatedSku = (sku || name.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase()).slice(0, 16);
  const finalImage = (image || imageUrl || '').trim() || null;
  const newProduct = {
    id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    sku: generatedSku,
    sellerId: req.seller.id,
    name: sanitizeInput(name.trim()),
    category: sanitizeInput(category || req.seller.brandCategory || 'General Products'),
    price: parseFloat(price),
    stock: Math.max(0, parseInt(stock, 10) || 0),
    description: sanitizeInput((description || name).trim()),
    notes: sanitizeInput(notes.trim()),
    image: finalImage,
    createdAt: new Date().toISOString()
  };

  productsStore.unshift(newProduct);
  saveJSON(PRODUCTS_FILE, productsStore);

  res.status(201).json({ success: true, product: newProduct });
});

// Update Product Stock Count in Stock CRM (Requires Owner or salesman with stockAccess)
app.put('/api/products/:id/stock', requireAuth, (req, res) => {
  if (!hasStockAccess(req.seller)) {
    return res.status(403).json({ error: 'Access denied. Stock CRM editing permission required. Please contact store owner.' });
  }

  const { stock, delta } = req.body;
  const prodIndex = productsStore.findIndex(p => 
    (p.sellerId === req.seller.id || p.sellerId === 'ALL') &&
    (p.id === req.params.id || 
    (p.sku && p.sku.toUpperCase() === req.params.id.toUpperCase()))
  );
  if (prodIndex === -1) {
    return res.status(404).json({ error: 'Product not found or belongs to another store.' });
  }

  let targetProduct = productsStore[prodIndex];
  if (targetProduct.sellerId === 'ALL') {
    // Clone shared template into seller-specific catalog to preserve multi-tenant isolation
    const cloned = {
      ...targetProduct,
      id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      sellerId: req.seller.id,
      stock: targetProduct.stock || 0,
      createdAt: new Date().toISOString()
    };
    productsStore.unshift(cloned);
    targetProduct = cloned;
  }

  if (typeof stock === 'number') {
    targetProduct.stock = Math.max(0, Math.floor(stock));
  } else if (typeof delta === 'number') {
    const current = typeof targetProduct.stock === 'number' ? targetProduct.stock : 0;
    targetProduct.stock = Math.max(0, current + Math.floor(delta));
  } else {
    return res.status(400).json({ error: 'Please provide either stock count or delta value.' });
  }

  saveJSON(PRODUCTS_FILE, productsStore);
  res.json({ success: true, product: targetProduct });
});

// Delete Product from Catalog (Requires Owner or staff with stockAccess)
app.delete('/api/products/:id', requireAuth, (req, res) => {
  if (!hasStockAccess(req.seller)) {
    return res.status(403).json({ error: 'Access denied. Stock CRM management permission required.' });
  }
  const prodIndex = productsStore.findIndex(p => 
    (p.sellerId === req.seller.id) && 
    (p.id === req.params.id || (p.sku && p.sku.toUpperCase() === req.params.id.toUpperCase()))
  );
  if (prodIndex === -1) {
    return res.status(404).json({ error: 'Product not found or belongs to another store.' });
  }
  const removed = productsStore.splice(prodIndex, 1)[0];
  saveJSON(PRODUCTS_FILE, productsStore);
  res.json({ success: true, message: `Product "${removed.name}" deleted from catalog.` });
});

// Helper to decrement product stock strictly upon verified payment confirmation (idempotent)
function decrementProductStockOnPayment(order) {
  if (!order || order.stockDecremented) return null;
  const cleanSku = (order.sku || '').trim().toLowerCase();
  const cleanDesc = (order.itemDescription || '').trim().toLowerCase();
  const matchedProduct = productsStore.find(p => 
    (p.sellerId === order.sellerId || p.sellerId === 'ALL') && 
    ((order.productId && p.id === order.productId) ||
     (cleanSku && p.sku && p.sku.toLowerCase() === cleanSku) ||
     p.name.toLowerCase() === cleanDesc)
  );

  if (matchedProduct && typeof matchedProduct.stock === 'number') {
    if (matchedProduct.stock > 0) {
      matchedProduct.stock = Math.max(0, matchedProduct.stock - 1);
      order.stockDecremented = true;
      saveJSON(PRODUCTS_FILE, productsStore);
      console.log(`📦 Verified Bank Payment for #REF-${order.ref}: Stock decremented for "${matchedProduct.name}" (SKU: ${matchedProduct.sku}) → ${matchedProduct.stock} remaining.`);
      return matchedProduct;
    }
  }
  order.stockDecremented = true;
  return null;
}

// ==========================================
// 2. ORDER CREATION & LIFECYCLE MANAGEMENT
// ==========================================

// Create a new Sale / Payment Link (Auth Required)
app.post('/api/orders', requireAuth, (req, res) => {
  const { customerName = '', customerPhone = '', itemDescription, itemDesc, amount, notes = '', customerNotes = '', sku = '', saveToCatalog = false } = req.body;
  const desc = (itemDescription || itemDesc || '').trim();
  const note = (notes || customerNotes || '').trim();

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0 || !desc) {
    return res.status(400).json({ error: 'Valid positive Amount and Item Description are required.' });
  }

  const seller = req.seller;

  // 1. Locate matching product in catalog to verify inventory
  const cleanSku = (sku || '').trim().toLowerCase();
  const cleanDesc = desc.toLowerCase();
  const matchedProduct = productsStore.find(p => 
    (p.sellerId === seller.id || p.sellerId === 'ALL') && 
    ((cleanSku && p.sku && p.sku.toLowerCase() === cleanSku) ||
     p.name.toLowerCase() === cleanDesc)
  );

  // 2. Enforce Stock CRM rules: Block link generation if item is out of stock!
  if (matchedProduct && typeof matchedProduct.stock === 'number') {
    if (matchedProduct.stock <= 0) {
      return res.status(400).json({
        error: `"${matchedProduct.name}" is currently OUT OF STOCK (0 units available). Stock access permission is required to replenish this item before an order link can be created.`
      });
    }
  }

  // If saveToCatalog is requested, auto-save this product to catalog database (Only if user has stock access)
  if (saveToCatalog && hasStockAccess(req.seller)) {
    const existingProd = productsStore.find(p => 
      (p.sellerId === seller.id || p.sellerId === 'ALL') && 
      p.name.toLowerCase() === cleanDesc
    );
    if (!existingProd) {
      const autoSku = (sku || desc.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase()).slice(0, 14);
      const newCatalogItem = {
        id: `prod_${Date.now()}`,
        sku: autoSku,
        sellerId: seller.id,
        name: desc,
        category: seller.brandCategory || 'General Products',
        price: parseFloat(amount),
        stock: 5, // initial default stock
        description: desc,
        notes: note,
        createdAt: new Date().toISOString()
      };
      productsStore.unshift(newCatalogItem);
      saveJSON(PRODUCTS_FILE, productsStore);
    }
  }

  // NOTE: Stock is NOT decremented upon link generation (in case customer never makes purchase).
  // Stock strictly decrements ONLY upon verified bank payment confirmation!

  // Generate cryptographic checkout token (e.g. kav_8f9a2b7c4d)
  const checkoutToken = generateCheckoutToken(seller.brandName);
  
  // Generate store-scoped sequential invoice ID for internal use
  const invoiceId = generateInvoiceId(seller.id);

  // Multi-Tenant Isolation: Store-scoped reference for bank narration & internal tracking
  // Avoids cross-tenant order number collision (e.g. Kaveri order #137, Royal Silk #138)
  const storeOrders = ordersStore.filter(o => o.sellerId === seller.id);
  const storePrefix = (seller.brandName || 'ORD').replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase() || 'ORD';
  
  let maxRefSeq = 0;
  for (const o of storeOrders) {
    const refStr = String(o.storeRef || o.ref || '');
    const m = refStr.match(new RegExp(`^${storePrefix}-(\\d+)`, 'i'));
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxRefSeq) maxRefSeq = num;
    }
  }
  let nextSeq = Math.max(storeOrders.length + 1, maxRefSeq + 1);
  let nextRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`;
  while (ordersStore.some(o => o.sellerId === seller.id && (o.storeRef === nextRef || o.ref === nextRef))) {
    nextSeq++;
    nextRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`;
  }

  const cleanName = (customerName || '').trim();
  const cleanPhone = (customerPhone || '').replace(/\D/g, '').slice(-10);
  const baseAmt = parseFloat(amount);
  const payableAmt = baseAmt; // Clean exact price without artificial paise
  const vpa = seller.upiId || 'store@upi';

  // Construct UPI deep-link URL with store ref and token
  const upiIntentUrl = `upi://pay?pa=${vpa}&pn=${encodeURIComponent(seller.brandName)}&am=${payableAmt.toFixed(2)}&cu=INR&tn=${encodeURIComponent('REF ' + nextRef + ' ' + checkoutToken)}&tr=${nextRef}`;

  const isSalesman = seller.currentRole === 'SALESMAN';
  const orderSalesmanId = isSalesman ? seller.currentSalesmanId : (req.body.salesmanId || null);
  const orderSalesmanName = isSalesman ? (seller.currentSalesmanName || 'Staff Desk') : (seller.currentRole === 'OWNER' ? 'Owner / Store Master' : 'Staff Desk');

  const newOrder = {
    token: checkoutToken,
    checkoutToken: checkoutToken,
    ref: nextRef,
    storeRef: nextRef,
    invoiceId,
    id: `ord_${checkoutToken}_${Date.now()}`,
    sellerId: seller.id,
    customerSessionKey: null,
    salesmanId: orderSalesmanId,
    salesmanName: orderSalesmanName,
    productId: matchedProduct ? matchedProduct.id : null,
    sku: sku ? sku.trim() : (matchedProduct ? matchedProduct.sku : null),
    productImage: (matchedProduct && matchedProduct.image) || (req.body.image || req.body.imageUrl || null),
    brandName: seller.brandName,
    brandCategory: seller.brandCategory,
    brandColor: seller.brandColor || '#4f46e5',
    storeLocation: seller.storeLocation || null,
    storeInstagram: seller.storeInstagram || null,
    storeLogo: seller.storeLogo || null,
    assuranceText: seller.assuranceText || 'Your item is handcrafted and reserved exclusively for you.',
    customerName: cleanName,
    customerPhone: cleanPhone,
    itemDescription: desc,
    amount: baseAmt,
    payableAmount: payableAmt,
    currency: 'INR',
    notes: note,
    upiId: vpa,
    upiIntentUrl,
    status: 'PENDING',
    paymentMethod: null,
    paymentRef: null,
    utr: null,
    paidAt: null,
    createdAt: new Date().toISOString(),
    address: null,
    dispatchStatus: 'PENDING',
    trackingNumber: null,
    steps: {
      shared: { done: true, time: new Date().toISOString() },
      opened: { done: false, time: null },
      addressEntered: { done: false, time: null },
      redirectedToPayment: { done: false, time: null, app: null },
      paymentConfirmed: { done: false, time: null, utr: null, method: null },
      spreadsheetUpdated: { done: false, time: null, rowNumber: null, sheetName: 'Master Sales Sheet' }
    },
    currentStep: 'WAITING_FOR_USER'
  };

  ordersStore.unshift(newOrder);
  saveJSON(ORDERS_FILE, ordersStore);

  const origin = `${req.protocol}://${req.get('host')}`;
  const payUrl = `${origin}/pay?token=${checkoutToken}`;

  // Pre-formatted high-converting WhatsApp message
  const greeting = cleanName ? `Hi ${cleanName.split(' ')[0]}!` : 'Hello!';
  const formattedPrice = `₹${newOrder.payableAmount.toLocaleString('en-IN')}`;
  const whatsappPitch = `${greeting} ✨\n\nYour order for *${newOrder.itemDescription}* (${formattedPrice}) with ${newOrder.brandName} is ready.\n\nTap below to confirm your shipping address & pay securely via GPay/PhonePe/UPI:\n👉 ${payUrl}\n\nFast express dispatch upon confirmation!`;

  const waLink = cleanPhone 
    ? `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(whatsappPitch)}`
    : `https://wa.me/?text=${encodeURIComponent(whatsappPitch)}`;

  res.status(201).json({
    success: true,
    order: newOrder,
    payUrl,
    checkoutUrl: payUrl,
    checkoutToken,
    whatsappPitch,
    waLink
  });
});

// Fetch orders scoped by role:
// - Salesman: ONLY sees their own sales
// - Store Owner: Sees ALL store sales + master breakdown across all salesmen
app.get('/api/orders', requireAuth, (req, res) => {
  const { status, search, salesmanId } = req.query;
  const sellerId = req.seller.id;
  const isSalesman = req.seller.currentRole === 'SALESMAN';
  const currentSalesmanId = req.seller.currentSalesmanId;

  // Base store orders
  let baseOrders = ordersStore.filter(o => o.sellerId === sellerId);

  // If salesman, strictly isolate to their own sales (disregard query parameters)
  if (isSalesman) {
    baseOrders = currentSalesmanId ? baseOrders.filter(o => o.salesmanId === currentSalesmanId) : [];
  } else if (salesmanId && salesmanId !== 'ALL') {
    // Owner can filter by specific salesman
    baseOrders = baseOrders.filter(o => o.salesmanId === salesmanId);
  }

  let filteredOrders = [...baseOrders];
  filteredOrders.forEach(normalizeOrderSteps);

  if (status && status !== 'ALL') {
    filteredOrders = filteredOrders.filter(o => o.status === status);
  }

  if (search) {
    const q = search.toLowerCase();
    filteredOrders = filteredOrders.filter(o => 
      (o.ref && o.ref.toLowerCase().includes(q)) ||
      (o.customerName && o.customerName.toLowerCase().includes(q)) ||
      (o.customerPhone && o.customerPhone.includes(q)) ||
      o.itemDescription.toLowerCase().includes(q) ||
      (o.utr && o.utr.toLowerCase().includes(q)) ||
      (o.salesmanName && o.salesmanName.toLowerCase().includes(q))
    );
  }

  // Calculate metrics for the active view
  const totalPaid = baseOrders.filter(o => o.status === 'PAID');
  const revenue = totalPaid.reduce((sum, o) => sum + parseFloat(o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0);
  const pendingOrders = baseOrders.filter(o => o.status === 'PENDING').length;
  const dispatchedOrders = baseOrders.filter(o => o.dispatchStatus === 'DISPATCHED').length;

  const responsePayload = {
    role: req.seller.currentRole || 'OWNER',
    orders: filteredOrders,
    metrics: {
      totalOrders: baseOrders.length,
      paidCount: totalPaid.length,
      revenue,
      pendingCount: pendingOrders,
      dispatchedCount: dispatchedOrders
    }
  };

  if (isSalesman) {
    responsePayload.salesman = {
      id: currentSalesmanId,
      name: req.seller.currentSalesmanName
    };
    // Salesman personal funnel
    const smOrders = baseOrders;
    const smPaid = smOrders.filter(o => o.status === 'PAID');
    responsePayload.myFunnel = {
      sent: smOrders.length,
      viewed: smOrders.filter(o => o.steps && o.steps.opened && o.steps.opened.done).length,
      addressAdded: smOrders.filter(o => o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done)).length,
      paymentStarted: smOrders.filter(o => o.status === 'PAID' || (o.steps && o.steps.redirectedToPayment && o.steps.redirectedToPayment.done)).length,
      paid: smPaid.length,
      revenue: smPaid.reduce((sum, o) => sum + (o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0),
      conversionRate: smOrders.length > 0 ? Math.round((smPaid.length / smOrders.length) * 100) : 0,
      abandonedAtAddress: smOrders.filter(o => o.status !== 'PAID' && (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done))).length
    };
    // Salesman's OWN abandoned leads ONLY
    responsePayload.abandonedLeads = smOrders.filter(o => 
      o.status !== 'PAID' && 
      (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done))
    );
  } else {
    // Owner Master Dashboard gets complete breakdown across all staff
    const allStoreOrders = ordersStore.filter(o => o.sellerId === sellerId);
    allStoreOrders.forEach(normalizeOrderSteps);
    const storeSalesmen = req.seller.salesmen || [];
    
    const breakdown = storeSalesmen.map(sm => {
      const smOrders = allStoreOrders.filter(o => o.salesmanId === sm.id);
      const smPaid = smOrders.filter(o => o.status === 'PAID');
      const smRev = smPaid.reduce((sum, o) => sum + (o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0);
      const smViewed = smOrders.filter(o => o.steps && o.steps.opened && o.steps.opened.done).length;
      const smAddr = smOrders.filter(o => o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done)).length;
      const smPayStarted = smOrders.filter(o => o.status === 'PAID' || (o.steps && o.steps.redirectedToPayment && o.steps.redirectedToPayment.done)).length;
      const conversionRate = smOrders.length > 0 ? Math.round((smPaid.length / smOrders.length) * 100) : 0;
      const abandonedAtAddress = smOrders.filter(o => o.status !== 'PAID' && (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done))).length;

      return {
        id: sm.id,
        name: sm.name,
        pin: sm.pin,
        sent: smOrders.length,
        totalOrders: smOrders.length,
        viewed: smViewed,
        addressAdded: smAddr,
        paymentStarted: smPayStarted,
        paid: smPaid.length,
        paidOrders: smPaid.length,
        revenue: smRev,
        pendingOrders: smOrders.filter(o => o.status === 'PENDING').length,
        conversionRate,
        abandonedAtAddress
      };
    });

    const overallFunnel = {
      sent: allStoreOrders.length,
      viewed: allStoreOrders.filter(o => o.steps && o.steps.opened && o.steps.opened.done).length,
      addressAdded: allStoreOrders.filter(o => o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done)).length,
      paymentStarted: allStoreOrders.filter(o => o.status === 'PAID' || (o.steps && o.steps.redirectedToPayment && o.steps.redirectedToPayment.done)).length,
      paid: allStoreOrders.filter(o => o.status === 'PAID').length,
      revenue: allStoreOrders.filter(o => o.status === 'PAID').reduce((sum, o) => sum + (o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0),
      conversionRate: allStoreOrders.length > 0 ? Math.round((allStoreOrders.filter(o => o.status === 'PAID').length / allStoreOrders.length) * 100) : 0,
      abandonedAtAddress: allStoreOrders.filter(o => o.status !== 'PAID' && (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done))).length
    };

    // Extract high-intent abandoned leads (entered address but didn't pay)
    const abandonedLeads = allStoreOrders.filter(o => 
      o.status !== 'PAID' && 
      (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done))
    );

    responsePayload.allSalesmen = storeSalesmen;
    responsePayload.salesmenBreakdown = breakdown;
    responsePayload.storeFunnel = overallFunnel;
    responsePayload.abandonedLeads = abandonedLeads;
  }

  res.json(responsePayload);
});

// Get a single order by Token or Ref (Public customer checkout page)
// Token-first lookup: ?token=kav_8f9a2b7c4d -> /api/orders/kav_8f9a2b7c4d
app.get('/api/orders/:tokenOrRef', (req, res) => {
  const tokenOrRef = req.params.tokenOrRef;
  const order = findOrderByTokenOrRef(tokenOrRef);
  if (!order) {
    return res.status(404).json({ error: 'Order not found. Please check your link.' });
  }

  normalizeOrderSteps(order);

  // Guarantee seller brand branding is present
  const seller = sellersStore.find(s => s.id === order.sellerId);
  if (!order.brandName) {
    if (seller) {
      order.brandName = seller.brandName;
      order.brandCategory = seller.brandCategory;
      order.upiId = order.upiId || seller.upiId;
    } else {
      order.brandName = 'Merchant Store';
      order.brandCategory = 'Retail & Goods';
    }
  }

  // Register customer link opened event
  if (req.query.track !== 'false' && !order.steps.opened.done) {
    order.steps.opened = { done: true, time: new Date().toISOString() };
    if (order.currentStep === 'WAITING_FOR_USER') {
      order.currentStep = 'LINK_OPENED';
    }
    saveJSON(ORDERS_FILE, ordersStore);
  }

  // Ensure payable amount exists
  if (order.payableAmount === undefined) {
    order.payableAmount = order.amount;
  }

  // Check current stock from product database
  const matchedProduct = productsStore.find(p => 
    (p.sellerId === order.sellerId || p.sellerId === 'ALL') && 
    ((order.sku && p.sku && p.sku.toLowerCase() === order.sku.toLowerCase()) ||
     p.name.toLowerCase() === order.itemDescription.toLowerCase())
  );

  const isOutOfStock = Boolean(
    order.isOutOfStock || 
    (order.status === 'PENDING' && matchedProduct && typeof matchedProduct.stock === 'number' && matchedProduct.stock <= 0)
  );

  // Determine if this is an internal dashboard request vs active customer session vs public viewer
  const authToken = extractToken(req);
  const authedSeller = authToken ? getSellerByToken(authToken) : null;
  const isInternalRequest = authedSeller && authedSeller.id === order.sellerId;
  const customerSessionHeader = req.headers['x-order-session'];
  const isCustomerOwner = customerSessionHeader && order.customerSessionKey && customerSessionHeader === order.customerSessionKey;

  // Build store branding payload for checkout
  const storeBranding = {
    storeLocation: (seller && seller.storeLocation) || order.storeLocation || null,
    storeInstagram: (seller && seller.storeInstagram) || order.storeInstagram || null,
    storeLogo: (seller && seller.storeLogo) || order.storeLogo || null,
    assuranceText: (seller && seller.assuranceText) || order.assuranceText || 'Your item is handcrafted and reserved exclusively for you.'
  };

  if (isInternalRequest || isCustomerOwner) {
    // Internal Staff or Original Customer Session: Full unmasked data
    const fullOrder = {
      ...order,
      ...storeBranding,
      productImage: (matchedProduct && matchedProduct.image) || order.productImage || null,
      sellerPhone: (seller && seller.phone) || order.sellerPhone || '',
      storePhone: (seller && seller.phone) || order.sellerPhone || '',
      isOutOfStock,
      currentStock: matchedProduct ? matchedProduct.stock : null
    };
    fullOrder.order = { ...fullOrder };
    res.json(fullOrder);
  } else {
    // Public checkout view (unauthenticated / stranger scraping): Mask sensitive customer PII
    const maskedOrder = {
      token: order.token,
      checkoutToken: order.token,
      ref: order.ref,
      storeRef: order.ref,
      invoiceId: order.invoiceId,
      brandName: order.brandName,
      brandCategory: order.brandCategory,
      brandColor: order.brandColor,
      ...storeBranding,
      customerName: maskName(order.customerName),
      customerPhone: maskPhone(order.customerPhone),
      itemDescription: order.itemDescription,
      amount: order.amount,
      payableAmount: order.payableAmount,
      currency: order.currency,
      notes: order.notes,
      sku: order.sku,
      upiId: order.upiId,
      upiIntentUrl: order.upiIntentUrl,
      status: order.status,
      paidAt: order.paidAt,
      utr: order.utr,
      paymentMethod: order.paymentMethod,
      address: order.address ? maskAddress(order.address) : null,
      steps: order.steps,
      currentStep: order.currentStep,
      createdAt: order.createdAt,
      sellerPhone: maskPhone((seller && seller.phone) || order.sellerPhone || ''),
      storePhone: maskPhone((seller && seller.phone) || order.sellerPhone || ''),
      productImage: (matchedProduct && matchedProduct.image) || order.productImage || null,
      isOutOfStock,
      currentStock: matchedProduct ? matchedProduct.stock : null
    };
    maskedOrder.order = { ...maskedOrder };
    res.json(maskedOrder);
  }
});

// Customer lifecycle event (e.g. redirected to payment app)
app.post('/api/orders/:tokenOrRef/event', (req, res) => {
  const order = findOrderByTokenOrRef(req.params.tokenOrRef);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  normalizeOrderSteps(order);
  const { event, app: appName } = req.body;

  if (event === 'LINK_OPENED') {
    if (!order.steps.opened.done) {
      order.steps.opened = { done: true, time: new Date().toISOString() };
      if (order.currentStep === 'WAITING_FOR_USER') {
        order.currentStep = 'LINK_OPENED';
      }
      saveJSON(ORDERS_FILE, ordersStore);
    }
  } else if (event === 'REDIRECTED_TO_PAYMENT') {
    order.steps.redirectedToPayment = {
      done: true,
      time: new Date().toISOString(),
      app: appName || 'UPI Payment App'
    };
    if (order.status !== 'PAID') {
      order.currentStep = 'REDIRECTED_TO_PAYMENT';
    }
    saveJSON(ORDERS_FILE, ordersStore);

    // Fast-trigger banking inbox check within 1s so payment confirmation arrives instantaneously!
    setTimeout(() => {
      triggerBankingPoller();
    }, 1000);
  }

  res.json({ success: true, order });
});

// Customer saves shipping address
app.post('/api/orders/:tokenOrRef/address', (req, res) => {
  const orderIndex = findOrderIndex(req.params.tokenOrRef);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const { fullName, phone, flat, street, landmark = '', pincode, city, state } = req.body;

  if (!fullName || !phone || !flat || !pincode || !city || !state) {
    return res.status(400).json({ error: 'Please fill in all mandatory address fields.' });
  }

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  const cleanPincode = pincode.replace(/\D/g, '');

  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  if (cleanPincode.length !== 6) {
    return res.status(400).json({ error: 'Please enter a valid 6-digit postal PIN code.' });
  }

  normalizeOrderSteps(ordersStore[orderIndex]);

  ordersStore[orderIndex].address = {
    fullName: sanitizeInput(fullName.trim()),
    phone: cleanPhone,
    flat: sanitizeInput(flat.trim()),
    street: sanitizeInput((street || '').trim()),
    landmark: sanitizeInput((landmark || '').trim()),
    pincode: cleanPincode,
    city: sanitizeInput(city.trim()),
    state: sanitizeInput(state.trim())
  };

  // Also update top-level customer fields so they persist
  ordersStore[orderIndex].customerName = sanitizeInput(fullName.trim());
  ordersStore[orderIndex].customerPhone = cleanPhone;

  ordersStore[orderIndex].steps.addressEntered = {
    done: true,
    time: new Date().toISOString()
  };
  if (ordersStore[orderIndex].status !== 'PAID') {
    ordersStore[orderIndex].currentStep = 'ADDRESS_ENTERED';
  }

  // Generate unique session key for active editing session
  if (!ordersStore[orderIndex].customerSessionKey) {
    ordersStore[orderIndex].customerSessionKey = crypto.randomBytes(16).toString('hex');
  }

  saveJSON(ORDERS_FILE, ordersStore);

  res.json({
    success: true,
    message: 'Shipping address saved successfully.',
    customerSessionKey: ordersStore[orderIndex].customerSessionKey,
    order: ordersStore[orderIndex]
  });
});

// Manual 12-digit UTR submission by customer (fallback)
app.post('/api/orders/:tokenOrRef/utr', utrLimiter, (req, res) => {
  const { utr } = req.body;
  if (!utr || !/^\d{12}$/.test(utr.trim())) {
    return res.status(400).json({ error: 'Please enter a valid 12-digit UPI reference number (UTR).' });
  }

  const cleanUtr = utr.trim();
  const orderIndex = findOrderIndex(req.params.tokenOrRef);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const order = ordersStore[orderIndex];

  // Return early if order is already paid
  if (order.status === 'PAID') {
    return res.status(200).json({
      success: true,
      message: 'Order has already been confirmed as paid.',
      order: ordersStore[orderIndex]
    });
  }

  // Anti-fraud / anti-replay: Ensure this UTR has not already been used for another paid order
  const duplicateUtrOrder = ordersStore.find(o => o.utr === cleanUtr && o.status === 'PAID');
  if (duplicateUtrOrder) {
    return res.status(400).json({ error: 'This 12-digit UPI reference number (UTR) has already been claimed for another order.' });
  }

  // Check if piece is already sold out by another completed sale
  const cleanSku = (order.sku || '').trim().toLowerCase();
  const cleanDesc = (order.itemDescription || '').trim().toLowerCase();
  const matchedProd = productsStore.find(p => 
    (p.sellerId === order.sellerId || p.sellerId === 'ALL') && 
    ((order.productId && p.id === order.productId) ||
     (cleanSku && p.sku && p.sku.toLowerCase() === cleanSku) ||
     p.name.toLowerCase() === cleanDesc)
  );
  if (matchedProd && typeof matchedProd.stock === 'number' && matchedProd.stock <= 0) {
    ordersStore[orderIndex].isOutOfStock = true;
    saveJSON(ORDERS_FILE, ordersStore);
    return res.status(400).json({ error: 'This item has just been claimed by another customer and is currently out of stock. Please contact the store on WhatsApp.' });
  }

  // Fallback Match: Check if this 12-digit UTR matches an unallocated credit received for this store
  const payableAmt = order.payableAmount !== undefined ? order.payableAmount : order.amount;
  const creditIdx = unmatchedCreditsStore.findIndex(c => 
    c.utr === cleanUtr && 
    (!c.sellerId || c.sellerId === order.sellerId) &&
    Math.abs(c.amount - payableAmt) < 0.01
  );

  let verifiedReason = 'Manual 12-digit UTR verification by customer';
  let verifiedVia = 'customer_utr';
  if (creditIdx !== -1) {
    verifiedReason = `Bank email alert confirmed via customer 12-digit UTR match (${order.brandName})`;
    verifiedVia = 'bank_email_matched_by_utr';
    unmatchedCreditsStore.splice(creditIdx, 1);
    saveJSON(UNMATCHED_CREDITS_FILE, unmatchedCreditsStore);
  }

  normalizeOrderSteps(ordersStore[orderIndex]);

  const now = new Date().toISOString();
  ordersStore[orderIndex].status = 'PAID';
  ordersStore[orderIndex].utr = cleanUtr;
  ordersStore[orderIndex].paymentMethod = creditIdx !== -1 ? 'Direct UPI (Bank Alert + Customer UTR)' : 'Direct UPI (Customer Verified UTR)';
  ordersStore[orderIndex].paymentRef = `utr_${cleanUtr}`;
  ordersStore[orderIndex].paidAt = now;
  ordersStore[orderIndex].verifiedVia = verifiedVia;
  ordersStore[orderIndex].matchReason = verifiedReason;

  ordersStore[orderIndex].steps.paymentConfirmed = {
    done: true,
    time: now,
    utr: cleanUtr,
    method: ordersStore[orderIndex].paymentMethod
  };

  ordersStore[orderIndex].steps.spreadsheetUpdated = {
    done: true,
    time: new Date().toISOString(),
    rowNumber: ordersStore.length - orderIndex + 1,
    sheetName: 'Master Sales Sheet'
  };

  ordersStore[orderIndex].currentStep = 'SPREADSHEET_UPDATED';

  if (ordersStore[orderIndex].dispatchStatus === 'PENDING') {
    ordersStore[orderIndex].dispatchStatus = 'PACKING';
  }

  saveJSON(ORDERS_FILE, ordersStore);

  // Decrement stock strictly upon verified payment confirmation!
  decrementProductStockOnPayment(ordersStore[orderIndex]);

  res.json({
    success: true,
    message: 'Payment verified successfully with UTR.',
    order: ordersStore[orderIndex]
  });
});

// Seller manually marks order as paid (Owner exclusive)
app.post('/api/orders/:tokenOrRef/mark-paid', requireOwner, (req, res) => {
  const orderIndex = findOrderIndex(req.params.tokenOrRef, req.seller.id);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const { paymentMethod = 'Manual Bank Verification / Cash', utr } = req.body;

  if (ordersStore[orderIndex].status === 'PAID') {
    return res.status(200).json({
      success: true,
      message: 'Order is already marked as paid.',
      order: ordersStore[orderIndex]
    });
  }

  normalizeOrderSteps(ordersStore[orderIndex]);

  ordersStore[orderIndex].status = 'PAID';
  ordersStore[orderIndex].paymentMethod = paymentMethod;
  ordersStore[orderIndex].paymentRef = `settle_${Date.now()}`;
  ordersStore[orderIndex].utr = utr || 'MANUAL-SETTLED';
  ordersStore[orderIndex].paidAt = new Date().toISOString();
  ordersStore[orderIndex].verifiedVia = 'admin_manual';
  ordersStore[orderIndex].steps.paymentConfirmed = {
    done: true,
    time: ordersStore[orderIndex].paidAt,
    utr: ordersStore[orderIndex].utr,
    method: paymentMethod
  };
  ordersStore[orderIndex].steps.spreadsheetUpdated = {
    done: true,
    time: new Date().toISOString(),
    rowNumber: ordersStore.length - orderIndex + 1,
    sheetName: 'Master Sales Sheet'
  };
  ordersStore[orderIndex].currentStep = 'SPREADSHEET_UPDATED';

  if (ordersStore[orderIndex].dispatchStatus === 'PENDING') {
    ordersStore[orderIndex].dispatchStatus = 'PACKING';
  }

  saveJSON(ORDERS_FILE, ordersStore);

  // Decrement stock strictly upon verified payment confirmation!
  decrementProductStockOnPayment(ordersStore[orderIndex]);

  res.json({
    success: true,
    message: 'Order marked paid manually.',
    order: ordersStore[orderIndex]
  });
});

// Update dispatch status (e.g. PACKING -> DISPATCHED)
app.post('/api/orders/:tokenOrRef/dispatch', requireAuth, (req, res) => {
  const { status, trackingNumber } = req.body;
  const orderIndex = findOrderIndex(req.params.tokenOrRef, req.seller.id);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  // Salesman can ONLY update dispatch status for their own sales
  if (req.seller.currentRole === 'SALESMAN' && ordersStore[orderIndex].salesmanId !== req.seller.currentSalesmanId) {
    return res.status(403).json({ error: 'Access denied. You can only update dispatch status for your own sales.' });
  }

  if (status) {
    const validStatuses = ['PENDING', 'PACKING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
    const cleanStatus = String(status).trim().toUpperCase();
    if (!validStatuses.includes(cleanStatus)) {
      return res.status(400).json({ error: `Invalid dispatch status. Allowed: ${validStatuses.join(', ')}` });
    }
    ordersStore[orderIndex].dispatchStatus = cleanStatus;
  }
  if (trackingNumber !== undefined) {
    ordersStore[orderIndex].trackingNumber = sanitizeInput((trackingNumber || '').trim());
  }
  saveJSON(ORDERS_FILE, ordersStore);

  res.json({ success: true, order: ordersStore[orderIndex] });
});

// ==========================================
// 3. BANK EMAIL ENGINE & VERIFICATION
// ==========================================

function parseBankEmail(emailPayload) {
  let text = '';
  let from = '';

  if (typeof emailPayload === 'string') {
    text = emailPayload;
  } else if (emailPayload && typeof emailPayload === 'object') {
    from = emailPayload.from || emailPayload.From || emailPayload.sender || emailPayload['from-header'] || '';
    text = [
      emailPayload.subject,
      emailPayload.text,
      emailPayload.body,
      emailPayload['stripped-text'],
      emailPayload['body-plain'],
      emailPayload.TextBody,
      emailPayload.content,
      emailPayload.html,
      emailPayload.raw
    ].filter(Boolean).join(' \n ');
  }

  // Strip HTML tags for clean regex scanning
  const cleanText = text.replace(/<[^>]+>/g, ' ');

  let amount = null;
  let utr = null;
  let orderRef = null;
  let payerName = null;

  // Amount extraction (supports "INR 50.00", "Rs 50.00", "Rs. 4,500.00", "₹ 3,500", "₹1200", "credited with INR 50.00")
  const amtMatches = [
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)/i,
    /credited\s+(?:with|by|for)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i,
    /received\s+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i,
    /payment\s+of\s+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)/i
  ];
  for (const regex of amtMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const clean = match[1].replace(/,/g, '');
      const parsed = parseFloat(clean);
      if (!isNaN(parsed) && parsed > 0) {
        amount = parsed;
        break;
      }
    }
  }

  // 12-digit UTR extraction
  const utrMatches = [
    /(?:upi\s*ref|rrn|utr|txn\s*id|ref\s*no|reference\s*no)[\s:/#-]*([0-9]{12})/i,
    /upi\/[a-z0-9_-]*\/([0-9]{12})\//i,
    /upi\/([0-9]{12})/i,
    /(?:\b)([0-9]{12})(?:\b)/
  ];
  for (const regex of utrMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      utr = match[1];
      break;
    }
  }

  // Cryptographic token extraction (e.g. kav_8f9a2b7c4d or ach_cace51ccbf)
  const tokenMatch = cleanText.match(/\b([a-z0-9]{3}_[a-f0-9]{8,12})\b/i);
  const token = tokenMatch ? tokenMatch[1] : null;

  // Order Ref extraction (handles store-scoped e.g. ACH-034, KAV-001, REF-101, REF ACH-034)
  const refMatches = [
    /ref(?:erence)?[:\s#_-]*([a-z]{3}-[0-9]{3})/i,
    /#?([a-z]{3}-[0-9]{3})\b/i,
    /ref(?:erence)?[:\s#_-]*([a-z0-9_-]{3,12})/i
  ];
  for (const regex of refMatches) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      orderRef = match[1].trim();
      break;
    }
  }

  return {
    from,
    amount,
    utr,
    orderRef,
    token,
    payerName,
    rawText: cleanText.substring(0, 400)
  };
}

// Unified Core Processor for Bank Credits (shared by IMAP, Webhooks, and Testing)
function processBankCreditForStore(sellerId, parsed, fromAddress) {
  const seller = sellersStore.find(s => s.id === sellerId);
  if (!seller) return { success: false, reason: 'Store not found.' };

  // Strict Anti-Spoofing Check: Verify sender address
  if (fromAddress) {
    const isVerified = isVerifiedBankSender(fromAddress, seller.bankingAutomation);
    if (!isVerified) {
      console.warn(`[Security Alert] Rejected unverified email from "${fromAddress}" for store "${seller.brandName}". Expected bank sender.`);
      return {
        success: false,
        error: `Email rejected: Sender "${fromAddress}" does not match the verified bank alert address (${seller.bankingAutomation?.verifiedSenderEmail || 'Official bank alerts only'}). Blocked to prevent fraudulent payment alerts.`
      };
    }
  }

  if (!parsed.amount && !parsed.orderRef && !parsed.token) {
    return {
      success: false,
      reason: 'Could not extract credit amount, token, or order reference from email.'
    };
  }

  // Filter pending orders strictly scoped to this store
  const pendingOrders = ordersStore.filter(o => o.sellerId === sellerId && o.status === 'PENDING');
  let matchedOrder = null;
  let matchReason = '';

  // 1. Match by cryptographic token (e.g. kav_8f9a2b7c4d or ach_cace51ccbf)
  if (parsed.token) {
    matchedOrder = pendingOrders.find(o => o.token && o.token.toLowerCase() === parsed.token.toLowerCase());
    if (matchedOrder) matchReason = `Token #${parsed.token} in bank narration`;
  }

  // 2. Match by store-scoped Order Ref or Invoice (e.g. ACH-034, INV-2026-034)
  if (!matchedOrder && parsed.orderRef) {
    const cleanRef = String(parsed.orderRef).trim().toLowerCase();
    matchedOrder = pendingOrders.find(o => 
      String(o.ref).toLowerCase() === cleanRef ||
      (o.token && o.token.toLowerCase().includes(cleanRef)) ||
      (o.invoiceId && o.invoiceId.toLowerCase() === cleanRef)
    );
    if (matchedOrder) matchReason = `Order Ref #${parsed.orderRef} in bank narration`;
  }

  // 3. Match by exact payable amount
  if (!matchedOrder && parsed.amount) {
    const matchedByAmount = pendingOrders.filter(o => {
      const payable = (o.payableAmount !== undefined ? o.payableAmount : o.amount);
      return Math.abs(payable - parsed.amount) < 0.009;
    });

    if (matchedByAmount.length === 1) {
      matchedOrder = matchedByAmount[0];
      matchReason = `Exact amount match ₹${parsed.amount.toFixed(2)}`;
    } else if (matchedByAmount.length >= 2) {
      const storeName = seller.brandName || 'Store';
      console.warn(`⚠️ Multi-Order Collision: ${matchedByAmount.length} pending orders for ₹${parsed.amount.toFixed(2)} at ${storeName}. Stored for Fallback Match: Manual 12-digit UTR verification.`);

      const unmatchedCredit = {
        id: `unm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sellerId: seller.id,
        storeName,
        amount: parsed.amount,
        utr: parsed.utr || null,
        candidateOrderTokens: matchedByAmount.map(o => o.token),
        candidateOrderRefs: matchedByAmount.map(o => o.ref),
        receivedAt: new Date().toISOString(),
        rawText: parsed.rawText
      };
      unmatchedCreditsStore.unshift(unmatchedCredit);
      saveJSON(UNMATCHED_CREDITS_FILE, unmatchedCreditsStore);

      return {
        success: false,
        ambiguous: true,
        candidateCount: matchedByAmount.length,
        storeName,
        message: `Collision detected: ${matchedByAmount.length} pending orders for ₹${parsed.amount.toFixed(2)}. Stored for Fallback Match: Manual 12-digit UTR verification.`,
        unmatchedCredit
      };
    }
  }

  if (!matchedOrder) {
    return {
      success: false,
      reason: 'No matching pending order found for this credit notification.'
    };
  }

  // MANDATORY SECURITY & RECONCILIATION: Strict Amount Verification
  // The received amount in the bank alert MUST match the demanded payable amount
  const demandedAmount = parseFloat(matchedOrder.payableAmount !== undefined ? matchedOrder.payableAmount : matchedOrder.amount);
  if (parsed.amount === null || parsed.amount === undefined || isNaN(parseFloat(parsed.amount))) {
    console.warn(`[Security Alert] Credit rejected for Order #${matchedOrder.ref}: Could not extract a valid received credit amount from bank alert.`);
    return {
      success: false,
      reason: `Verification failed: Bank notification did not contain an extracted credit amount to verify against demanded ₹${demandedAmount.toFixed(2)}.`
    };
  }

  const receivedAmount = parseFloat(parsed.amount);
  if (Math.abs(receivedAmount - demandedAmount) >= 0.01) {
    console.warn(`[Security Alert] Amount mismatch for Order #${matchedOrder.ref}: Demanded ₹${demandedAmount.toFixed(2)}, Received ₹${receivedAmount.toFixed(2)}.`);
    return {
      success: false,
      mismatch: true,
      demandedAmount,
      receivedAmount,
      reason: `Amount mismatch: Order demands ₹${demandedAmount.toFixed(2)}, but bank notification indicates ₹${receivedAmount.toFixed(2)} received. Credit rejected to protect store revenue.`
    };
  }

  // Confirm order
  const orderIndex = ordersStore.findIndex(o => o.token === matchedOrder.token || o.ref === matchedOrder.ref);

  // Anti-fraud / anti-replay: ensure bank alert UTR has not already been claimed by another paid order
  if (parsed.utr) {
    const duplicatePaid = ordersStore.find(o => o.utr === parsed.utr && o.status === 'PAID');
    if (duplicatePaid && duplicatePaid.token !== matchedOrder.token) {
      console.warn(`[Anti-Fraud Alert] Bank notification UTR ${parsed.utr} already claimed by Order #${duplicatePaid.ref}.`);
      return {
        success: false,
        error: `Duplicate UTR ${parsed.utr}: Already claimed for Order #${duplicatePaid.ref}. Notification rejected.`
      };
    }
  }

  const now = new Date().toISOString();
  const utr = parsed.utr || `EMAIL-${Date.now().toString().slice(-8)}`;

  normalizeOrderSteps(ordersStore[orderIndex]);

  const bankName = seller.bankingAutomation?.bankName || 'Verified Bank';
  ordersStore[orderIndex].status = 'PAID';
  ordersStore[orderIndex].paymentMethod = `Bank Email (${bankName} UPI)`;
  ordersStore[orderIndex].paymentRef = `pay_Email_${Date.now()}`;
  ordersStore[orderIndex].utr = utr;
  ordersStore[orderIndex].paidAt = now;
  ordersStore[orderIndex].verifiedVia = 'bank_email';
  ordersStore[orderIndex].matchReason = matchReason;
  if (fromAddress) ordersStore[orderIndex].verifiedSender = fromAddress;

  ordersStore[orderIndex].steps.paymentConfirmed = {
    done: true,
    time: now,
    utr,
    method: `Bank Email (${bankName} UPI)`
  };

  ordersStore[orderIndex].steps.spreadsheetUpdated = {
    done: true,
    time: now,
    rowNumber: ordersStore.length - orderIndex + 1,
    sheetName: 'Master Sales Sheet'
  };

  ordersStore[orderIndex].currentStep = 'SPREADSHEET_UPDATED';

  if (ordersStore[orderIndex].dispatchStatus === 'PENDING') {
    ordersStore[orderIndex].dispatchStatus = 'PACKING';
  }

  saveJSON(ORDERS_FILE, ordersStore);
  decrementProductStockOnPayment(ordersStore[orderIndex]);

  console.log(`✅ Order #${matchedOrder.token || matchedOrder.ref} confirmed via Verified Bank Email (${matchReason}) from ${fromAddress || 'Inbox'}`);

  return {
    success: true,
    message: `Order #${matchedOrder.token || matchedOrder.ref} verified via bank credit alert!`,
    order: ordersStore[orderIndex],
    matchReason,
    extracted: parsed
  };
}

// Inbound Bank Email Webhook endpoint
app.post('/api/webhook/bank-email', (req, res) => {
  // If WEBHOOK_SHARED_SECRET is configured in production, authenticate caller
  const sharedSecret = process.env.WEBHOOK_SHARED_SECRET;
  if (sharedSecret) {
    const providedSecret = req.query.secret || req.headers['x-webhook-secret'] || (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '');
    if (providedSecret !== sharedSecret) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing webhook shared secret.' });
    }
  }

  const emailPayload = req.body || {};
  const parsed = parseBankEmail(emailPayload);

  console.log('Received Inbound Bank Email Webhook:', parsed);

  // Identify Target Store
  let matchedSeller = null;
  if (req.query.storeId) {
    matchedSeller = sellersStore.find(s => s.id === req.query.storeId);
  }
  if (!matchedSeller && req.headers['x-store-id']) {
    matchedSeller = sellersStore.find(s => s.id === req.headers['x-store-id']);
  }
  // Lookup store via token or orderRef if present in narration
  if (!matchedSeller && (parsed.token || parsed.orderRef)) {
    const matchedOrd = ordersStore.find(o => 
      (parsed.token && o.token && o.token.toLowerCase() === parsed.token.toLowerCase()) ||
      (parsed.orderRef && (String(o.ref).toLowerCase() === String(parsed.orderRef).toLowerCase() || (o.storeRef && String(o.storeRef).toLowerCase() === String(parsed.orderRef).toLowerCase())))
    );
    if (matchedOrd) {
      matchedSeller = sellersStore.find(s => s.id === matchedOrd.sellerId);
    }
  }
  if (!matchedSeller) {
    const rawLower = (parsed.rawText || '').toLowerCase();
    matchedSeller = sellersStore.find(s => {
      const upiPart = (s.upiId || '').toLowerCase();
      const brandPart = (s.brandName || '').toLowerCase();
      const emailPart = (s.email || '').toLowerCase();
      return (upiPart && rawLower.includes(upiPart)) || 
             (brandPart && rawLower.includes(brandPart)) ||
             (emailPart && rawLower.includes(emailPart));
    });
  }
  // Safe routing: If only 1 single boutique exists with active monitoring, route to it; never guess across multiple stores
  if (!matchedSeller && sellersStore.length === 1) {
    if (sellersStore[0].bankingAutomation && sellersStore[0].bankingAutomation.monitoringActive) {
      matchedSeller = sellersStore[0];
    }
  }

  if (!matchedSeller) {
    return res.status(200).json({
      success: false,
      message: 'Email acknowledged, but target boutique store could not be authenticated. Pass ?storeId=YOUR_STORE_ID or include a matching reference.'
    });
  }

  const fromHeader = parsed.from || req.headers['from'] || req.headers['x-from'] || req.body.from || req.body.sender || '';
  const result = processBankCreditForStore(matchedSeller.id, parsed, fromHeader);
  return res.status(200).json(result);
});

// Test Gmail IMAP Connection endpoint (For Store Settings UI - Owner Only)
app.post('/api/seller/test-email-connection', requireOwner, async (req, res) => {
  const { imapUser, imapAppPassword, imapHost, imapPort, bankCode, verifiedSenderEmail } = req.body;
  const seller = sellersStore.find(s => s.id === req.seller.id);
  const userToUse = (imapUser || (seller && seller.bankingAutomation && seller.bankingAutomation.imapUser) || (seller && seller.email) || '').trim();
  const storedPass = seller && seller.bankingAutomation && seller.bankingAutomation.imapAppPassword ? decryptSecret(seller.bankingAutomation.imapAppPassword) : '';
  const passwordToUse = (imapAppPassword || storedPass || '').trim();

  if (!userToUse || !passwordToUse) {
    return res.status(400).json({ error: 'Please enter both your Gmail address and 16-character App Password.' });
  }

  const cleanPass = passwordToUse.replace(/\s+/g, '').trim();

  const client = new ImapFlow({
    host: imapHost || 'imap.gmail.com',
    port: parseInt(imapPort, 10) || 993,
    secure: true,
    auth: {
      user: userToUse,
      pass: cleanPass
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let totalMessages = 0;
    let bankAlertsFound = 0;

    try {
      totalMessages = client.mailbox?.exists || 0;

      const senderToSearch = verifiedSenderEmail || (BANK_PRESETS[bankCode] && BANK_PRESETS[bankCode].verifiedSender);
      if (senderToSearch) {
        const uids = await client.search({ from: senderToSearch });
        bankAlertsFound = (uids || []).length;
      }
    } finally {
      lock.release();
    }

    await client.logout();

    res.json({
      success: true,
      message: `Connected successfully to Gmail! Inbox has ${totalMessages} total emails (${bankAlertsFound} official alerts from ${verifiedSenderEmail || 'your bank'}).`,
      totalMessages,
      bankAlertsFound
    });
  } catch (err) {
    console.error('Test IMAP Connection error:', err.message);
    let errMsg = err.message;
    if (err.message.includes('Authentication') || err.message.includes('Invalid credentials') || err.message.includes('LOGIN')) {
      errMsg = 'Invalid Gmail credentials. Ensure 2-Step Verification is ON, generate a 16-letter App Password at myaccount.google.com/apppasswords, and paste it here.';
    }
    res.status(400).json({
      success: false,
      error: errMsg
    });
  }
});

// Test Parse / Ingest Sample Email endpoint (For Store Settings UI Tester - Owner Only)
app.post('/api/seller/test-ingest-email', requireOwner, (req, res) => {
  const { emailText, fromAddress } = req.body;
  if (!emailText || !emailText.trim()) {
    return res.status(400).json({ error: 'Please paste the bank alert email text.' });
  }

  const parsed = parseBankEmail(emailText);
  const seller = sellersStore.find(s => s.id === req.seller.id);
  const from = fromAddress || seller.bankingAutomation?.verifiedSenderEmail || 'bankingalerts@icicibank.com';

  const result = processBankCreditForStore(req.seller.id, parsed, from);
  res.json({
    ...result,
    parsed
  });
});

// ========================================================
// 4. GOOGLE OAUTH 2.0 & GMAIL REST API AUTOMATION ENGINE
// ========================================================

function getGoogleCredentials() {
  let clientId = process.env.GOOGLE_CLIENT_ID || '';
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  if ((!clientId || !clientSecret) && fs.existsSync(OAUTH_CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(OAUTH_CONFIG_FILE, 'utf8'));
      if (cfg.clientId) clientId = cfg.clientId;
      if (cfg.clientSecret) clientSecret = cfg.clientSecret;
    } catch (e) {
      console.warn('Could not read oauth_config.json:', e.message);
    }
  }

  return { clientId: (clientId || '').trim(), clientSecret: (clientSecret || '').trim() };
}

function getGoogleOAuthRedirectUri(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || '127.0.0.1:3000';
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  return `${proto}://${host}/api/auth/google/callback`;
}

// Admin API to view / update Google OAuth Client credentials for the platform (Owner Only)
app.get('/api/admin/oauth-config', requireOwner, (req, res) => {
  const creds = getGoogleCredentials();
  res.json({
    configured: Boolean(creds.clientId && creds.clientSecret),
    clientId: creds.clientId ? `${creds.clientId.substring(0, 16)}...` : '',
    redirectUri: getGoogleOAuthRedirectUri(req)
  });
});

app.post('/api/admin/oauth-config', requireOwner, (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Both Google Client ID and Client Secret are required.' });
  }

  const cleanId = clientId.trim();
  const cleanSec = clientSecret.trim();

  saveJSON(OAUTH_CONFIG_FILE, {
    clientId: cleanId,
    clientSecret: cleanSec,
    updatedAt: new Date().toISOString()
  });

  console.log('[Google OAuth] Platform credentials saved successfully.');
  res.json({
    success: true,
    message: 'Google OAuth credentials saved! Store owners can now connect Gmail with 1-click.'
  });
});

// 1-Click Connect Endpoint: Initiates Google OAuth consent screen for the logged-in seller (Owner Only)
app.get('/api/auth/google/connect', requireOwner, (req, res) => {
  const creds = getGoogleCredentials();
  const redirectUri = getGoogleOAuthRedirectUri(req);

  if (!creds.clientId || !creds.clientSecret) {
    return res.status(400).json({
      error: 'Google OAuth credentials are not configured yet on this PaySap instance.',
      notConfigured: true,
      redirectUri
    });
  }

  const state = crypto.randomBytes(16).toString('hex') + ':' + req.seller.id;
  // Store state token in session for CSRF validation on callback
  sessionsStore['__oauth_state_' + state.split(':')[0]] = {
    sellerId: req.seller.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10-minute window
  };
  saveJSON(SESSIONS_FILE, sessionsStore);
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(creds.clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent&` +
    `state=${encodeURIComponent(state)}`;

  res.json({
    success: true,
    authUrl,
    redirectUri
  });
});

// OAuth Callback: Exchanges auth code for refresh & access tokens
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.warn('[Google OAuth] Authorization error:', error);
    return res.redirect(`/?tab=settings&google_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.redirect('/?tab=settings&google_error=Missing+authorization+code+or+state');
  }

  const parts = state.split(':');
  const stateNonce = parts[0];
  const sellerId = parts[1];

  // CSRF validation: verify state nonce was issued by us
  const storedState = sessionsStore['__oauth_state_' + stateNonce];
  if (!storedState || storedState.sellerId !== sellerId) {
    return res.redirect('/?tab=settings&google_error=Invalid+state+parameter.+Possible+CSRF+attempt.');
  }
  if (new Date(storedState.expiresAt) < new Date()) {
    delete sessionsStore['__oauth_state_' + stateNonce];
    saveJSON(SESSIONS_FILE, sessionsStore);
    return res.redirect('/?tab=settings&google_error=OAuth+session+expired.+Please+try+again.');
  }
  // Clean up used state token
  delete sessionsStore['__oauth_state_' + stateNonce];
  saveJSON(SESSIONS_FILE, sessionsStore);

  const seller = sellersStore.find(s => s.id === sellerId);

  if (!seller) {
    return res.redirect('/?tab=settings&google_error=Store+session+not+found');
  }

  const creds = getGoogleCredentials();
  const redirectUri = getGoogleOAuthRedirectUri(req);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Google OAuth] Token exchange failed:', tokenData);
      return res.redirect(`/?tab=settings&google_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'Token exchange failed')}`);
    }

    // Fetch verified email from Google UserInfo
    let userEmail = seller.email || '';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      if (userRes.ok) {
        const uInfo = await userRes.json();
        if (uInfo.email) userEmail = uInfo.email;
      }
    } catch (e) {
      console.warn('[Google OAuth] Could not fetch userinfo:', e.message);
    }

    if (!seller.bankingAutomation) seller.bankingAutomation = {};
    const existingRefresh = seller.bankingAutomation.googleOAuth ? decryptSecret(seller.bankingAutomation.googleOAuth.refreshToken) : null;
    seller.bankingAutomation.googleOAuth = {
      connected: true,
      connectedEmail: userEmail,
      refreshToken: encryptSecret(tokenData.refresh_token || existingRefresh),
      accessToken: encryptSecret(tokenData.access_token),
      tokenExpiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000),
      connectedAt: new Date().toISOString()
    };
    seller.bankingAutomation.monitoringActive = true;
    seller.bankingAutomation.lastCheckedAt = new Date().toISOString();
    seller.bankingAutomation.lastError = null;

    saveJSON(SELLERS_FILE, sellersStore);
    console.log(`[Google OAuth] 🟢 Successfully linked Gmail for store "${seller.brandName}" (${userEmail})`);

    res.redirect('/?tab=settings&google_connected=success');
  } catch (err) {
    console.error('[Google OAuth Exception]:', err);
    res.redirect(`/?tab=settings&google_error=${encodeURIComponent(err.message)}`);
  }
});

// Disconnect Google OAuth (Owner Only)
app.post('/api/auth/google/disconnect', requireOwner, (req, res) => {
  const sellerIndex = sellersStore.findIndex(s => s.id === req.seller.id);
  if (sellerIndex === -1) {
    return res.status(404).json({ error: 'Seller not found.' });
  }

  if (sellersStore[sellerIndex].bankingAutomation) {
    sellersStore[sellerIndex].bankingAutomation.googleOAuth = {
      connected: false,
      connectedEmail: null,
      refreshToken: null,
      accessToken: null,
      tokenExpiresAt: null,
      disconnectedAt: new Date().toISOString()
    };
    sellersStore[sellerIndex].bankingAutomation.monitoringActive = false;
  }

  saveJSON(SELLERS_FILE, sellersStore);
  console.log(`[Google OAuth] Disconnected store "${sellersStore[sellerIndex].brandName}".`);
  res.json({ success: true, message: 'Google account disconnected successfully.' });
});

// Auto-refresh Google access token before expiration
async function getValidGoogleAccessToken(seller) {
  const oauth = seller.bankingAutomation?.googleOAuth;
  if (!oauth || !oauth.connected || !oauth.refreshToken) return null;

  if (oauth.accessToken && oauth.tokenExpiresAt && (oauth.tokenExpiresAt - Date.now() > 180000)) {
    return decryptSecret(oauth.accessToken);
  }

  const creds = getGoogleCredentials();
  if (!creds.clientId || !creds.clientSecret) return null;

  const plainRefreshToken = decryptSecret(oauth.refreshToken);
  if (!plainRefreshToken) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: plainRefreshToken,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (res.ok && data.access_token) {
      oauth.accessToken = encryptSecret(data.access_token);
      if (data.refresh_token) {
        oauth.refreshToken = encryptSecret(data.refresh_token);
      }
      oauth.tokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
      saveJSON(SELLERS_FILE, sellersStore);
      return data.access_token;
    } else {
      console.error(`[Google OAuth - ${seller.brandName}] Token refresh error:`, data);
      return null;
    }
  } catch (err) {
    console.error(`[Google OAuth - ${seller.brandName}] Token refresh exception:`, err.message);
    return null;
  }
}

// In-memory cache of inspected Gmail message IDs (prevents infinite re-download loop on unread non-bank emails)
const inspectedGmailMsgIds = new Set();

// Gmail REST API Poller (Official Google API - Zero Password Required)
async function pollStoreGmail(seller) {
  const auto = seller.bankingAutomation;
  if (!auto || !auto.googleOAuth || !auto.googleOAuth.connected) return;

  const accessToken = await getValidGoogleAccessToken(seller);
  if (!accessToken) return;

  try {
    const rawSender = auto.verifiedSenderEmail || (BANK_PRESETS[auto.bankCode] && BANK_PRESETS[auto.bankCode].verifiedSender) || '';
    const senders = rawSender ? rawSender.split(/[,;]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean) : [];
    const personalDomains = ['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'];
    const validBankSenders = senders.filter(s => !personalDomains.some(d => s.toLowerCase().endsWith(d)));

    let query;
    if (validBankSenders.length > 0) {
      const fromParts = validBankSenders.map(s => `from:${s}`).join(' OR ');
      query = `newer_than:2d (${fromParts} OR (credit OR credited OR received OR UPI OR INR))`;
    } else {
      query = `newer_than:2d (credit OR credited OR received OR UPI OR INR)`;
    }

    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!listRes.ok) {
      console.warn(`[Gmail API - ${seller.brandName}] List messages response: ${listRes.status}`);
      return;
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];

    auto.lastCheckedAt = new Date().toISOString();
    auto.lastError = null;

    if (messages.length === 0) {
      saveJSON(SELLERS_FILE, sellersStore);
      return;
    }

    for (const msg of messages) {
      if (inspectedGmailMsgIds.has(msg.id)) continue;

      try {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!msgRes.ok) continue;

        const msgData = await msgRes.json();
        const headers = (msgData.payload && Array.isArray(msgData.payload.headers)) ? msgData.payload.headers : [];
        const fromHeader = headers.find(h => h && h.name && typeof h.name === 'string' && h.name.toLowerCase() === 'from')?.value || '';
        const subjectHeader = headers.find(h => h && h.name && typeof h.name === 'string' && h.name.toLowerCase() === 'subject')?.value || '';

        let bodyText = '';
        function extractBody(part) {
          if (!part) return;
          if (part.body && part.body.data) {
            try {
              const decoded = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
              bodyText += ' \n ' + decoded;
            } catch (e) {}
          }
          if (part.parts && Array.isArray(part.parts)) {
            part.parts.forEach(extractBody);
          }
        }
        extractBody(msgData.payload);

        // Anti-spoofing sender verification
        const isVerified = isVerifiedBankSender(fromHeader, auto);
        if (!isVerified) {
          inspectedGmailMsgIds.add(msg.id);
          if (inspectedGmailMsgIds.size > 500) {
            const first = inspectedGmailMsgIds.values().next().value;
            inspectedGmailMsgIds.delete(first);
          }
          continue;
        }

        const parsed = parseBankEmail({
          from: fromHeader,
          subject: subjectHeader,
          text: bodyText
        });

        const result = processBankCreditForStore(seller.id, parsed, fromHeader);
        inspectedGmailMsgIds.add(msg.id);
        if (inspectedGmailMsgIds.size > 500) {
          const first = inspectedGmailMsgIds.values().next().value;
          inspectedGmailMsgIds.delete(first);
        }

        if (result && result.success) {
          console.log(`[Gmail API - ${seller.brandName}] 🟢 Order #${result.order.ref} AUTO-SETTLED via official Gmail API!`);
          auto.lastMatchedAt = new Date().toISOString();

          // Mark message read in Gmail
          await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/modify`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
          });
        }
      } catch (itemErr) {
        inspectedGmailMsgIds.add(msg.id);
        console.warn(`[Gmail API - ${seller.brandName}] Error reading message ${msg.id}:`, itemErr.message);
      }
    }

    saveJSON(SELLERS_FILE, sellersStore);
  } catch (err) {
    console.error(`[Gmail API Error - ${seller.brandName}]:`, err.message);
    auto.lastError = err.message;
    auto.lastCheckedAt = new Date().toISOString();
    saveJSON(SELLERS_FILE, sellersStore);
  }
}

// Background Email Polling Loop (Prioritizes Google OAuth REST API, falls back to IMAP)
let isImapPollingActive = false;

async function checkStoreInbox(seller) {
  const auto = seller.bankingAutomation;
  if (!auto || !auto.monitoringActive || !auto.imapUser || !auto.imapAppPassword) {
    return;
  }

  const rawPass = decryptSecret(auto.imapAppPassword);
  const cleanPass = (rawPass || '').replace(/\s+/g, '').trim();
  if (!cleanPass) return;

  const client = new ImapFlow({
    host: auto.imapHost || 'imap.gmail.com',
    port: parseInt(auto.imapPort, 10) || 993,
    secure: true,
    auth: {
      user: auto.imapUser.trim(),
      pass: cleanPass
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const uids = await client.search({ seen: false });
      if (!uids || uids.length === 0) {
        auto.lastCheckedAt = new Date().toISOString();
        auto.lastError = null;
        saveJSON(SELLERS_FILE, sellersStore);
        return;
      }

      console.log(`[IMAP - ${seller.brandName}] Checking ${uids.length} unread email(s)...`);

      for (const uid of uids) {
        try {
          const download = await client.download(uid, ['source']);
          if (!download || !download.content) continue;

          const parsedEmail = await simpleParser(download.content);
          const fromAddress = parsedEmail.from?.value?.[0]?.address || parsedEmail.from?.text || '';

          // STRICT SENDER VERIFICATION
          const isVerified = isVerifiedBankSender(fromAddress, auto);
          if (!isVerified) {
            continue; // Not from verified bank address, skip
          }

          const parsedData = parseBankEmail({
            subject: parsedEmail.subject,
            text: parsedEmail.text,
            html: parsedEmail.html,
            from: fromAddress
          });

          const result = processBankCreditForStore(seller.id, parsedData, fromAddress);
          if (result && result.success) {
            console.log(`[IMAP - ${seller.brandName}] 🟢 Order #${result.order.ref} CONFIRMED & VERIFIED via bank alert email!`);
            auto.lastMatchedAt = new Date().toISOString();
            await client.messageFlagsAdd({ uid }, ['\\Seen']);
          }
        } catch (msgErr) {
          console.warn(`[IMAP - ${seller.brandName}] Message UID ${uid} read warning:`, msgErr.message);
        }
      }

      auto.lastCheckedAt = new Date().toISOString();
      auto.lastError = null;
      saveJSON(SELLERS_FILE, sellersStore);
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error(`[IMAP Error - ${seller.brandName}]:`, err.message);
    auto.lastError = err.message;
    auto.lastCheckedAt = new Date().toISOString();
    saveJSON(SELLERS_FILE, sellersStore);
  }
}

// Trigger a single banking poller pass across all stores
async function triggerBankingPoller() {
  if (isImapPollingActive) return;
  isImapPollingActive = true;
  try {
    for (const seller of sellersStore) {
      if (seller.bankingAutomation) {
        // Priority 1: Google OAuth REST API (Zero Password, 1-Click Connect, active 24/7)
        if (seller.bankingAutomation.googleOAuth && seller.bankingAutomation.googleOAuth.connected) {
          await pollStoreGmail(seller);
        } else if (seller.bankingAutomation.monitoringActive && seller.bankingAutomation.imapUser && seller.bankingAutomation.imapAppPassword) {
          // Priority 2: Fallback IMAP
          await checkStoreInbox(seller);
        }
      }
    }
  } catch (e) {
    console.error('[Banking Poller Error]:', e.message);
  } finally {
    isImapPollingActive = false;
  }
}

// Adaptive Banking Poller: Polls every 3.5s when any order is PENDING, 12s when idle
let bankingPollerTimeout = null;
async function scheduleAdaptiveBankingPoller() {
  if (bankingPollerTimeout) {
    clearTimeout(bankingPollerTimeout);
    bankingPollerTimeout = null;
  }
  try {
    await triggerBankingPoller();
  } catch (err) {
    console.error('[Adaptive Poller Error]:', err.message);
  }
  const hasPendingOrders = ordersStore.some(o => o.status === 'PENDING');
  const nextDelay = hasPendingOrders ? 3500 : 12000;
  bankingPollerTimeout = setTimeout(scheduleAdaptiveBankingPoller, nextDelay);
}

// Start adaptive banking poller
setTimeout(scheduleAdaptiveBankingPoller, 1500);

// Simulator endpoint for testing bank email webhook in UI (AUTH REQUIRED - Owner only in production)
app.post('/api/webhook/simulate-bank-email', (req, res) => {
  // In production, require authentication to prevent abuse
  if (process.env.NODE_ENV === 'production') {
    const authToken = extractToken(req);
    const seller = getSellerByToken(authToken);
    if (!seller || seller.currentRole !== 'OWNER') {
      return res.status(403).json({ error: 'Simulation endpoint requires store owner authentication in production.' });
    }
  }

  const { ref, token, amount, utr, bankName = 'HDFC Bank', simulateCollision = false } = req.body;
  if (!ref && !token && !amount) {
    return res.status(400).json({ error: 'Order ref, token, or amount is required.' });
  }

  const generatedUtr = utr || `43${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  const order = ordersStore.find(o => (token && o.token === token) || (ref && (o.ref === ref || o.token === ref)));
  const orderAmount = order ? (order.payableAmount || order.amount) : parseFloat(amount);
  const storeName = order ? order.brandName : 'Store';

  let emailBody;
  if (simulateCollision) {
    // Bank credit alert with NO order ref (simulates bank that omits narration reference)
    emailBody = `Dear Customer, INR ${orderAmount.toFixed(2)} credited to your ${bankName} A/c **9102 on ${new Date().toLocaleDateString('en-GB')} by UPI/${generatedUtr}/${storeName.replace(/\s+/g, '')}. Clear Bal: INR 45,980.00.`;
  } else {
    const narrationRef = order ? (order.token || order.ref) : (token || ref || 'ORD-001');
    emailBody = `Dear Customer, INR ${orderAmount.toFixed(2)} credited to your ${bankName} A/c **9102 on ${new Date().toLocaleDateString('en-GB')} by UPI/${generatedUtr}/REF_${narrationRef}. Clear Bal: INR 45,980.00.`;
  }

  const mockEmail = {
    subject: `Alert: INR ${orderAmount.toFixed(2)} credited to account via UPI (${storeName})`,
    body: emailBody
  };

  // Re-route internally to bank email webhook handler
  req.body = mockEmail;
  if (order) {
    req.query.storeId = order.sellerId;
  }
  const parsed = parseBankEmail(mockEmail);

  const matchedSeller = order ? sellersStore.find(s => s.id === order.sellerId) : null;
  const pendingOrders = matchedSeller 
    ? ordersStore.filter(o => o.sellerId === matchedSeller.id && o.status === 'PENDING')
    : ordersStore.filter(o => o.status === 'PENDING');

  let matchedOrder = null;
  let matchReason = '';

  if (parsed.token) {
    matchedOrder = pendingOrders.find(o => o.token && o.token.toLowerCase() === parsed.token.toLowerCase());
    if (matchedOrder) matchReason = `Checkout token #${parsed.token} in narration`;
  }

  if (!matchedOrder && parsed.orderRef) {
    const cleanRef = String(parsed.orderRef).trim().toLowerCase();
    matchedOrder = pendingOrders.find(o => 
      String(o.ref).toLowerCase() === cleanRef ||
      (o.token && o.token.toLowerCase().includes(cleanRef))
    );
    if (matchedOrder) matchReason = `Order Ref #${parsed.orderRef} in narration`;
  }

  if (!matchedOrder && parsed.amount) {
    const matchedByAmount = pendingOrders.filter(o => {
      const payable = (o.payableAmount !== undefined ? o.payableAmount : o.amount);
      return Math.abs(payable - parsed.amount) < 0.009;
    });

    if (matchedByAmount.length === 1) {
      matchedOrder = matchedByAmount[0];
      matchReason = `Order amount match ₹${parsed.amount.toFixed(2)}`;
    } else if (matchedByAmount.length >= 2) {
      // Collision detected! Store for manual UTR verification
      const sName = matchedSeller ? matchedSeller.brandName : 'Store';
      const unmatchedCredit = {
        id: `unm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        sellerId: matchedSeller ? matchedSeller.id : (matchedByAmount[0] ? matchedByAmount[0].sellerId : null),
        storeName: sName,
        amount: parsed.amount,
        utr: generatedUtr,
        candidateOrderTokens: matchedByAmount.map(o => o.token),
        candidateOrderRefs: matchedByAmount.map(o => o.ref),
        receivedAt: new Date().toISOString(),
        rawText: emailBody
      };
      unmatchedCreditsStore.unshift(unmatchedCredit);
      saveJSON(UNMATCHED_CREDITS_FILE, unmatchedCreditsStore);

      return res.status(200).json({
        success: false,
        ambiguous: true,
        candidateCount: matchedByAmount.length,
        storeName: sName,
        message: `Collision detected: ${matchedByAmount.length} pending orders for ₹${parsed.amount.toFixed(2)}. Bank omitted ref. Stored for Fallback Match: Manual 12-digit UTR verification.`,
        unmatchedCredit
      });
    }
  }

  if (!matchedOrder) {
    return res.status(404).json({ error: 'No matching pending order found to confirm.' });
  }

  const orderIndex = ordersStore.findIndex(o => o.token === matchedOrder.token || o.ref === matchedOrder.ref);
  const now = new Date().toISOString();

  normalizeOrderSteps(ordersStore[orderIndex]);

  ordersStore[orderIndex].status = 'PAID';
  ordersStore[orderIndex].paymentMethod = `Bank Email Alert (${bankName})`;
  ordersStore[orderIndex].paymentRef = `sim_${Date.now()}`;
  ordersStore[orderIndex].utr = generatedUtr;
  ordersStore[orderIndex].paidAt = now;
  ordersStore[orderIndex].verifiedVia = 'bank_email';
  ordersStore[orderIndex].matchReason = matchReason;

  ordersStore[orderIndex].steps.paymentConfirmed = {
    done: true,
    time: now,
    utr: generatedUtr,
    method: `Bank Email Alert (${bankName})`
  };

  ordersStore[orderIndex].steps.spreadsheetUpdated = {
    done: true,
    time: now,
    rowNumber: ordersStore.length - orderIndex + 1,
    sheetName: 'Master Sales Sheet'
  };

  ordersStore[orderIndex].currentStep = 'SPREADSHEET_UPDATED';

  if (ordersStore[orderIndex].dispatchStatus === 'PENDING') {
    ordersStore[orderIndex].dispatchStatus = 'PACKING';
  }

  saveJSON(ORDERS_FILE, ordersStore);

  // Decrement stock strictly upon verified payment confirmation!
  decrementProductStockOnPayment(ordersStore[orderIndex]);

  res.json({
    success: true,
    message: `Order #${matchedOrder.token || matchedOrder.ref} confirmed via simulated bank email!`,
    order: ordersStore[orderIndex],
    utr: generatedUtr,
    matchReason
  });
});

// ==========================================
// 4. PINCODE & CSV EXPORT
// ==========================================

// Pincode lookup with live India Post API, memory cache, and postal zone fallback
app.get('/api/pincode/:pincode', async (req, res) => {
  const pin = req.params.pincode ? req.params.pincode.trim() : '';
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ success: false, error: 'Invalid 6-digit Indian pincode' });
  }

  // 1. Check local cache
  const cached = PINCODE_CACHE[pin];
  if (cached) {
    return res.json({ success: true, data: cached });
  }

  // 2. Fetch from India Post Public API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500); // 2.5s max
    const apiRes = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (apiRes.ok) {
      const data = await apiRes.json();
      if (Array.isArray(data) && data[0] && data[0].Status === 'Success' && Array.isArray(data[0].PostOffice) && data[0].PostOffice.length > 0) {
        const po = data[0].PostOffice[0];
        const city = po.District || po.Division || po.Block || po.Circle;
        const state = po.State;
        const area = po.Name;
        const result = { city, state, area };
        // Save to cache for rapid subsequent lookups
        PINCODE_CACHE[pin] = result;
        return res.json({ success: true, data: result });
      }
    }
  } catch (err) {
    console.warn(`Pincode live lookup failed for ${pin}:`, err.message);
  }

  // 3. Fallback: Region detection based on Indian postal zone (first 2 digits)
  const zonePrefix = pin.substring(0, 2);
  const zoneMap = {
    '11': { city: 'New Delhi', state: 'Delhi' },
    '12': { city: 'Gurugram / Faridabad', state: 'Haryana' },
    '13': { city: 'Haryana', state: 'Haryana' },
    '14': { city: 'Punjab', state: 'Punjab' },
    '16': { city: 'Chandigarh', state: 'Punjab' },
    '17': { city: 'Himachal Pradesh', state: 'Himachal Pradesh' },
    '18': { city: 'Jammu', state: 'Jammu and Kashmir' },
    '19': { city: 'Srinagar', state: 'Jammu and Kashmir' },
    '20': { city: 'Noida / Ghaziabad', state: 'Uttar Pradesh' },
    '21': { city: 'Allahabad', state: 'Uttar Pradesh' },
    '22': { city: 'Lucknow', state: 'Uttar Pradesh' },
    '24': { city: 'Dehradun', state: 'Uttarakhand' },
    '28': { city: 'Agra', state: 'Uttar Pradesh' },
    '30': { city: 'Jaipur', state: 'Rajasthan' },
    '31': { city: 'Udaipur', state: 'Rajasthan' },
    '34': { city: 'Jodhpur', state: 'Rajasthan' },
    '38': { city: 'Ahmedabad', state: 'Gujarat' },
    '39': { city: 'Surat / Vadodara', state: 'Gujarat' },
    '40': { city: 'Mumbai', state: 'Maharashtra' },
    '41': { city: 'Pune', state: 'Maharashtra' },
    '42': { city: 'Nashik', state: 'Maharashtra' },
    '44': { city: 'Nagpur', state: 'Maharashtra' },
    '45': { city: 'Indore', state: 'Madhya Pradesh' },
    '46': { city: 'Bhopal', state: 'Madhya Pradesh' },
    '49': { city: 'Raipur', state: 'Chhattisgarh' },
    '50': { city: 'Hyderabad', state: 'Telangana' },
    '51': { city: 'Tirupati', state: 'Andhra Pradesh' },
    '52': { city: 'Vijayawada', state: 'Andhra Pradesh' },
    '53': { city: 'Visakhapatnam', state: 'Andhra Pradesh' },
    '56': { city: 'Bengaluru', state: 'Karnataka' },
    '57': { city: 'Mangalore', state: 'Karnataka' },
    '58': { city: 'Hubballi / Karnataka', state: 'Karnataka' },
    '59': { city: 'Belagavi', state: 'Karnataka' },
    '60': { city: 'Chennai', state: 'Tamil Nadu' },
    '61': { city: 'Thanjavur', state: 'Tamil Nadu' },
    '62': { city: 'Madurai', state: 'Tamil Nadu' },
    '64': { city: 'Coimbatore', state: 'Tamil Nadu' },
    '67': { city: 'Kozhikode / Kannur', state: 'Kerala' },
    '68': { city: 'Thrissur / Kochi / Kottayam', state: 'Kerala' },
    '69': { city: 'Thiruvananthapuram / Kollam', state: 'Kerala' },
    '70': { city: 'Kolkata', state: 'West Bengal' },
    '75': { city: 'Bhubaneswar', state: 'Odisha' },
    '78': { city: 'Guwahati', state: 'Assam' },
    '80': { city: 'Patna', state: 'Bihar' },
    '83': { city: 'Ranchi', state: 'Jharkhand' }
  };

  if (zoneMap[zonePrefix]) {
    return res.json({ success: true, data: zoneMap[zonePrefix] });
  }

  // If completely unknown, return 404 so UI can let customer enter city manually
  return res.status(404).json({
    success: false,
    error: 'Pincode not recognized. Please verify your address.'
  });
});

// Export Master Dispatch CSV (Requires Authentication & Role Scoping)
app.get('/api/export/csv', requireAuth, (req, res) => {
  let exportOrders = ordersStore.filter(o => o.sellerId === req.seller.id);
  if (req.seller.currentRole === 'SALESMAN') {
    exportOrders = exportOrders.filter(o => o.salesmanId === req.seller.currentSalesmanId);
  }

  const headers = [
    'Sheet Row',
    'Order Ref',
    'Date Created',
    'Paid At',
    'Customer Name',
    'Customer Mobile',
    'Item Description',
    'Base Amount (INR)',
    'Payable Amount (INR)',
    'Payment Status',
    'Bank UTR',
    'Verification Mode',
    'Flat/House',
    'Street',
    'Landmark',
    'City',
    'State',
    'Pincode',
    'Dispatch Status',
    'Tracking Number'
  ];

  function escapeCsvCell(val) {
    if (val === null || val === undefined) return '""';
    let s = String(val).replace(/"/g, '""');
    // Prepend single quote if value begins with formula trigger characters to neutralize spreadsheet injection
    if (/^[=\+\-@\t\r]/.test(s)) {
      s = "'" + s;
    }
    return `"${s}"`;
  }

  const rows = exportOrders.map((o, idx) => {
    const a = o.address || {};
    return [
      escapeCsvCell(`Row #${idx + 2}`),
      escapeCsvCell(`REF-${o.ref}`),
      escapeCsvCell(o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN') : ''),
      escapeCsvCell(o.paidAt ? new Date(o.paidAt).toLocaleString('en-IN') : ''),
      escapeCsvCell(o.customerName || ''),
      escapeCsvCell(o.customerPhone || ''),
      escapeCsvCell(o.itemDescription || ''),
      escapeCsvCell(o.amount || ''),
      escapeCsvCell(o.payableAmount || o.amount || ''),
      escapeCsvCell(o.status || ''),
      escapeCsvCell(o.utr || ''),
      escapeCsvCell(o.paymentMethod || o.verifiedVia || ''),
      escapeCsvCell(a.flat || ''),
      escapeCsvCell(a.street || ''),
      escapeCsvCell(a.landmark || ''),
      escapeCsvCell(a.city || ''),
      escapeCsvCell(a.state || ''),
      escapeCsvCell(a.pincode || ''),
      escapeCsvCell(o.dispatchStatus || 'PENDING'),
      escapeCsvCell(o.trackingNumber || '')
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  const filename = `master_sales_sheet_${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvContent);
});

// ==========================================
// 5. PAGE SERVING ROUTES
// ==========================================

const PUBLIC_DIR = path.join(__dirname, 'public');

// Seller Authentication (Login / Register) Page
app.get('/auth', (req, res) => {
  res.sendFile('auth.html', { root: PUBLIC_DIR });
});
app.get('/login', (req, res) => {
  res.sendFile('auth.html', { root: PUBLIC_DIR });
});
app.get('/register', (req, res) => {
  res.sendFile('auth.html', { root: PUBLIC_DIR });
});

// Customer Checkout Page
app.get('/pay', (req, res) => {
  res.sendFile('pay.html', { root: PUBLIC_DIR });
});

// Master Dispatch Sheet
app.get('/dispatch', (req, res) => {
  res.sendFile('dispatch.html', { root: PUBLIC_DIR });
});

// Salesperson / Seller Studio (Multi-Tab Cockpit)
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: PUBLIC_DIR });
});

// Periodic Session Cleanup (every 6 hours - removes expired sessions)
setInterval(() => {
  const now = new Date();
  let cleaned = 0;
  for (const [token, session] of Object.entries(sessionsStore)) {
    if (token.startsWith('__oauth_state_')) {
      if (session.expiresAt && new Date(session.expiresAt) < now) {
        delete sessionsStore[token];
        cleaned++;
      }
    } else if (session.expiresAt && new Date(session.expiresAt) < now) {
      delete sessionsStore[token];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveJSON(SESSIONS_FILE, sessionsStore);
    console.log(`[Session Cleanup] Removed ${cleaned} expired sessions.`);
  }
}, 6 * 60 * 60 * 1000);

// Start Server
app.listen(PORT, () => {
  console.log(`\n✨ PaySap - Unified Merchant Payment Platform running on http://127.0.0.1:${PORT}`);
  console.log(`👉 Platform Auth:   http://127.0.0.1:${PORT}/auth`);
  console.log(`👉 Studio Cockpit:  http://127.0.0.1:${PORT}`);
  console.log(`👉 Dispatch Board:  http://127.0.0.1:${PORT}/dispatch\n`);
});
