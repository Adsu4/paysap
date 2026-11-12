const crypto = require('crypto');
const PaySapTheme = require('../../public/js/themes');
const { BANK_PRESETS } = require('../config/env');

function storeTheme(store) {
  const theme = PaySapTheme.resolve(store && (store.themeId || store.brandColor));
  return { themeId: theme.id, brandColor: theme.primary };
}

function sanitizeInput(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/[<>"'`]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c] || c);
}

function senderEmail(fromHeader) {
  const raw = String(fromHeader || '').trim().toLowerCase();
  const match = raw.match(/<([^<>]+)>/);
  const email = match ? match[1].trim() : raw;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) ? email : '';
}

function isVerifiedBankSender(fromHeader, automation = {}) {
  const email = senderEmail(fromHeader);
  if (!email) return false;
  const domain = email.split('@')[1];
  const configured = String(automation.verifiedSenderEmail || '').trim();
  let preset = BANK_PRESETS[automation.bankCode];
  if (!preset && automation.bankName) {
    const bName = String(automation.bankName).toLowerCase();
    preset = Object.values(BANK_PRESETS).find(p => p.name.toLowerCase().includes(bName) || bName.includes(p.name.toLowerCase()));
  }
  const expectedList = configured ? configured.split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  if (preset && preset.allowedDomains) {
    preset.allowedDomains.forEach(d => {
      if (!expectedList.includes(d)) expectedList.push(d);
    });
  }
  return expectedList.some(value => {
    const trusted = value.toLowerCase().trim().replace(/^@/, '');
    return trusted.includes('@') ? email === trusted : (domain === trusted || domain.endsWith('.' + trusted));
  });
}

function isAuthenticatedBankEmail(headers, fromHeader) {
  const email = senderEmail(fromHeader);
  if (!email || !Array.isArray(headers)) return false;
  const domain = email.split('@')[1];
  const result = headers.find(h => String(h.name || '').toLowerCase() === 'authentication-results');
  const value = String((result && result.value) || '').toLowerCase();
  if (!/^mx\.google\.com\s*;/.test(value) || !/\bdmarc=pass\b/.test(value)) return false;
  const alignedFrom = value.match(/header\.from=([^;\s]+)/);
  if (!alignedFrom || alignedFrom[1].replace(/[<>]/g, '') !== domain) return false;
  return /\b(?:dkim|spf)=pass\b/.test(value);
}

function generateCheckoutToken(brandName) {
  const prefix = (brandName || 'ord')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 3)
    .toLowerCase()
    .padEnd(3, 'x');
  const randomPart = crypto.randomBytes(16).toString('hex');
  return `${prefix}_${randomPart}`;
}

function maskName(name) {
  if (!name || name.length < 2) return name;
  const parts = name.trim().split(' ');
  return parts.map((part, i) => {
    if (i === 0) {
      if (part.length <= 4) return part;
      return part.substring(0, 4) + '*'.repeat(Math.min(part.length - 4, 4));
    }
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

function amountInPaise(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) return null;
  const amount = Number(str);
  const paise = Math.round(amount * 100);
  return Number.isSafeInteger(paise) && paise > 0 && paise <= 10000000000 ? paise : null;
}

function nonNegativePaise(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) return null;
  const paise = Math.round(Number(str) * 100);
  return Number.isSafeInteger(paise) && paise >= 0 && paise <= 10000000000 ? paise : null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, originalHash) {
  if (typeof password !== 'string' || typeof salt !== 'string' || typeof originalHash !== 'string') return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  if (hash.length !== originalHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

function createStaffPin(pin) {
  const pinSalt = crypto.randomBytes(16).toString('hex');
  return { pinSalt, pinHash: hashPassword(pin, pinSalt) };
}

function verifyStaffPin(staff, pin) {
  if (!/^\d{4}$/.test(pin)) return false;
  if (staff.pinHash && staff.pinSalt) return verifyPassword(pin, staff.pinSalt, staff.pinHash);
  return typeof staff.pin === 'string' && staff.pin === pin;
}

function safeStaff(staff) {
  const { pin, pinSalt, pinHash, ...safe } = staff;
  return { ...safe, stockAccess: staff.stockAccess === true };
}

function sanitizeSellerForRole(seller, role = 'OWNER') {
  if (!seller) return null;
  const safe = { ...seller };
  Object.assign(safe, storeTheme(seller));
  delete safe.passwordHash;
  delete safe.salt;
  delete safe.currentRole;
  delete safe.currentSalesmanId;
  delete safe.currentSalesmanName;
  if (Array.isArray(safe.salesmen)) safe.salesmen = safe.salesmen.map(safeStaff);
  if (safe.bankingAutomation) {
    safe.bankingAutomation = { ...safe.bankingAutomation };
    safe.bankingAutomation.hasAppPassword = Boolean(safe.bankingAutomation.imapAppPassword);
    delete safe.bankingAutomation.imapAppPassword;
    if (safe.bankingAutomation.googleOAuth) {
      safe.bankingAutomation.googleOAuth = { ...safe.bankingAutomation.googleOAuth };
      delete safe.bankingAutomation.googleOAuth.refreshToken;
      delete safe.bankingAutomation.googleOAuth.accessToken;
    }
  }
  if (role === 'SALESMAN') {
    delete safe.bankingAutomation;
    delete safe.salesmen;
    delete safe.googleOAuth;
  }
  return safe;
}

function isOrderClosed(order) {
  return ['CANCELLED', 'EXPIRED'].includes(order.status) || order.dispatchStatus === 'CANCELLED';
}

function addOrderActivity(order, type, actor = 'system', details = {}) {
  if (!Array.isArray(order.activity)) order.activity = [];
  order.activity.push({ type, actor, time: new Date().toISOString(), ...details });
}

function normalizeOrderSteps(order) {
  if (!order.steps) order.steps = {};
  if (!order.steps.shared) order.steps.shared = { done: false, time: null };
  if (!order.steps.opened) order.steps.opened = { done: false, time: null };
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
    if (!order.steps.spreadsheetUpdated) order.steps.spreadsheetUpdated = { done: false, time: null };
    order.currentStep = 'PAYMENT_CONFIRMED';
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

function sanitizePublicOrder(order, includeCustomerDetails = false, seller = null) {
  if (!order) return null;
  const payableAmount = order.payableAmount !== undefined ? order.payableAmount : (order.amount || 0);
  const theme = storeTheme(seller || order);
  return {
    token: order.token || '',
    checkoutToken: order.token || '',
    ref: order.storeRef || order.ref || '',
    invoiceId: order.invoiceId || '',
    brandName: order.brandName || '',
    brandCategory: order.brandCategory || '',
    ...theme,
    brandLogo: order.brandLogo || null,
    storeLogo: order.storeLogo || order.brandLogo || null,
    storeLocation: order.storeLocation || '',
    storeInstagram: order.storeInstagram || '',
    assuranceText: order.assuranceText || '',
    itemDescription: order.itemDescription || '',
    items: Array.isArray(order.items) ? order.items.map(it => ({
      name: it.name,
      sku: it.sku || '',
      quantity: it.quantity || 1,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal
    })) : [],
    subtotalAmount: order.subtotalAmount !== undefined ? order.subtotalAmount : (order.amount || 0),
    discountAmount: order.discountAmount || 0,
    shippingAmount: order.shippingAmount || 0,
    customerInstructions: order.customerInstructions || '',
    amount: order.amount || 0,
    payableAmount,
    currency: order.currency || 'INR',
    status: order.status || 'PENDING',
    paymentStatus: order.paymentStatus || (order.status === 'PAID' ? 'CONFIRMED' : (order.customerReportedUtr ? 'AWAITING_CONFIRMATION' : 'AWAITING_PAYMENT')),
    paymentMethod: order.paymentMethod || null,
    dispatchStatus: order.dispatchStatus || 'PENDING',
    trackingNumber: order.trackingNumber || null,
    fulfillmentIssue: order.fulfillmentIssue || null,
    refundDetails: order.refundDetails ? {
      status: order.refundDetails.status,
      amount: order.refundDetails.amount,
      method: order.refundDetails.method,
      refundedAt: order.refundDetails.refundedAt
    } : null,
    paidAt: order.paidAt || null,
    upiId: order.upiId || '',
    upiIntentUrl: order.upiIntentUrl || '',
    address: includeCustomerDetails ? (order.address || null) : maskAddress(order.address),
    addressMasked: Boolean(order.address && !includeCustomerDetails),
    customerName: includeCustomerDetails ? (order.customerName || '') : maskName(order.customerName || ''),
    customerPhone: includeCustomerDetails ? (order.customerPhone || '') : maskPhone(order.customerPhone || ''),
    storePhone: order.storePhone || order.sellerPhone || '',
    sellerPhone: order.storePhone || order.sellerPhone || '',
    productImage: order.productImage || null,
    sku: order.sku || '',
    isOutOfStock: Boolean(order.isOutOfStock),
    steps: Object.fromEntries(Object.entries(order.steps || {}).map(([key, step]) => [key, {
      done: Boolean(step && step.done), time: (step && step.time) || null
    }])),
    currentStep: order.currentStep || 'WAITING_FOR_USER',
    createdAt: order.createdAt || '',
    expiresAt: order.expiresAt || null
  };
}

function canManageOrder(seller, order) {
  return Boolean(seller && seller.id === order.sellerId &&
    (seller.currentRole === 'OWNER' || (seller.currentSalesmanId && seller.currentSalesmanId === order.salesmanId)));
}

function hasCustomerSession(req, order) {
  const supplied = req.headers['x-order-session'];
  return typeof supplied === 'string' && typeof order.customerSessionKey === 'string' &&
    /^[a-f0-9]{32}$/i.test(supplied) && supplied.length === order.customerSessionKey.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(order.customerSessionKey));
}

function hasStockAccess(seller) {
  if (!seller) return false;
  if (seller.currentRole === 'OWNER') return true;
  if (seller.currentRole === 'SALESMAN' && seller.currentSalesmanId) {
    const sm = (seller.salesmen || []).find(s => s.id === seller.currentSalesmanId);
    return sm ? sm.stockAccess === true : false;
  }
  return false;
}

module.exports = {
  storeTheme,
  sanitizeInput,
  senderEmail,
  isVerifiedBankSender,
  isAuthenticatedBankEmail,
  generateCheckoutToken,
  maskName,
  maskPhone,
  maskAddress,
  amountInPaise,
  nonNegativePaise,
  hashPassword,
  verifyPassword,
  createStaffPin,
  verifyStaffPin,
  safeStaff,
  sanitizeSellerForRole,
  isOrderClosed,
  addOrderActivity,
  normalizeOrderSteps,
  sanitizePublicOrder,
  canManageOrder,
  hasCustomerSession,
  hasStockAccess
};

