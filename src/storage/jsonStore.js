const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isOrderClosed, normalizeOrderSteps } = require('../utils/security');

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
    } catch (_) {
      fs.writeFileSync(filePath, content, 'utf8');
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    }
  } catch (_) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (directErr) {
      console.error(`Error saving ${filePath}:`, directErr);
      throw new Error('Data could not be saved. Please try again.');
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.files = {
      sellers: path.join(dataDir, 'sellers.json'),
      sessions: path.join(dataDir, 'sessions.json'),
      orders: path.join(dataDir, 'orders.json'),
      products: path.join(dataDir, 'products.json'),
      unmatchedCredits: path.join(dataDir, 'unmatched_credits.json'),
      oauthConfig: path.join(dataDir, 'oauth_config.json'),
      passwordResets: path.join(dataDir, 'password_resets.json')
    };
    this.sellers = loadJSON(this.files.sellers, []);
    this.sessions = loadJSON(this.files.sessions, {});
    this.orders = loadJSON(this.files.orders, []);
    this.products = loadJSON(this.files.products, []);
    this.unmatchedCredits = loadJSON(this.files.unmatchedCredits, []);
    this.passwordResets = loadJSON(this.files.passwordResets, []);
    this._txChain = Promise.resolve();
  }

  async init() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  async readyCheck() {
    fs.accessSync(this.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  }

  async close() {}

  async withTransaction(fn) {
    const run = this._txChain.then(async () => {
      const snapshot = {
        sellers: structuredClone(this.sellers),
        sessions: structuredClone(this.sessions),
        orders: structuredClone(this.orders),
        products: structuredClone(this.products),
        unmatchedCredits: structuredClone(this.unmatchedCredits),
        passwordResets: structuredClone(this.passwordResets)
      };
      try {
        return await fn(this);
      } catch (err) {
        this.sellers = snapshot.sellers;
        this.sessions = snapshot.sessions;
        this.orders = snapshot.orders;
        this.products = snapshot.products;
        this.unmatchedCredits = snapshot.unmatchedCredits;
        this.passwordResets = snapshot.passwordResets;
        throw err;
      }
    });
    this._txChain = run.catch(() => {});
    return run;
  }

  _save(key) {
    const dataMap = {
      sellers: this.sellers,
      sessions: this.sessions,
      orders: this.orders,
      products: this.products,
      unmatchedCredits: this.unmatchedCredits,
      passwordResets: this.passwordResets
    };
    saveJSON(this.files[key], dataMap[key]);
  }

  // --- Sellers ---
  async listSellers() { return this.sellers; }
  async findSellerById(id) { return this.sellers.find(s => s.id === id) || null; }
  async findSellerByEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    return this.sellers.find(s => s.email === clean) || null;
  }
  async findSellerByEmailOrId(identifier) {
    const clean = String(identifier || '').trim().toLowerCase();
    return this.sellers.find(s => s.email === clean || s.id.toLowerCase() === clean) || null;
  }
  async findPublicStores(lookup) {
    const clean = String(lookup || '').trim().toLowerCase();
    if (!clean) return [];
    return this.sellers
      .filter(s => s.id.toLowerCase() === clean || s.email.toLowerCase() === clean)
      .map(s => ({
        id: s.id,
        brandName: s.brandName,
        category: s.brandCategory,
        salesmen: (s.salesmen || []).map(sm => ({ id: sm.id, name: sm.name }))
      }));
  }
  async createSeller(seller) {
    this.sellers.push(seller);
    this._save('sellers');
    return seller;
  }
  async saveSeller(seller) {
    const idx = this.sellers.findIndex(s => s.id === seller.id);
    if (idx === -1) throw new Error('Seller not found');
    this.sellers[idx] = seller;
    this._save('sellers');
    return seller;
  }

  // --- Sessions & OAuth state ---
  async createSession(sellerId, role = 'OWNER', salesman = null) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = {
      sellerId,
      role: role || 'OWNER',
      salesmanId: salesman ? salesman.id : null,
      salesmanName: salesman ? salesman.name : null,
      stockAccess: salesman ? salesman.stockAccess === true : undefined,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    this._save('sessions');
    return token;
  }
  async getSession(token) {
    if (!token) return null;
    const session = this.sessions[token];
    if (!session) return null;
    if (new Date(session.expiresAt) < new Date()) {
      delete this.sessions[token];
      this._save('sessions');
      return null;
    }
    return session;
  }
  async deleteSession(token) {
    if (token && this.sessions[token]) {
      delete this.sessions[token];
      this._save('sessions');
    }
  }
  async deleteSessionsBySeller(sellerId, { exceptToken = null, salesmanId = null } = {}) {
    let changed = false;
    for (const [key, session] of Object.entries(this.sessions)) {
      if (session.sellerId !== sellerId) continue;
      if (exceptToken && key === exceptToken) continue;
      if (salesmanId && session.salesmanId !== salesmanId) continue;
      delete this.sessions[key];
      changed = true;
    }
    if (changed) this._save('sessions');
  }
  async updateSessionsStockAccess(sellerId, salesmanId, stockAccess) {
    let changed = false;
    for (const session of Object.values(this.sessions)) {
      if (session.sellerId === sellerId && session.salesmanId === salesmanId) {
        session.stockAccess = stockAccess;
        changed = true;
      }
    }
    if (changed) this._save('sessions');
  }
  async cleanupExpiredSessions() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of Object.entries(this.sessions)) {
      if (!session.expiresAt || Date.parse(session.expiresAt) <= now) {
        delete this.sessions[token];
        changed = true;
      }
    }
    if (changed) this._save('sessions');
  }
  async saveOAuthState(nonce, sellerId, expiresAt) {
    this.sessions[`__oauth_state_${nonce}`] = {
      sellerId,
      createdAt: new Date().toISOString(),
      expiresAt
    };
    this._save('sessions');
  }
  async consumeOAuthState(nonce) {
    const key = `__oauth_state_${nonce}`;
    const stored = this.sessions[key] || null;
    if (stored) {
      delete this.sessions[key];
      this._save('sessions');
    }
    return stored;
  }

  // --- Password Resets ---
  async createPasswordReset(sellerId, tokenHash, expiresAt) {
    this.passwordResets = this.passwordResets.filter(r => r.sellerId !== sellerId && Date.parse(r.expiresAt) > Date.now());
    const rec = {
      id: `rst_${crypto.randomBytes(10).toString('hex')}`,
      sellerId,
      tokenHash,
      expiresAt,
      usedAt: null,
      createdAt: new Date().toISOString()
    };
    this.passwordResets.push(rec);
    this._save('passwordResets');
    return rec;
  }
  async consumePasswordReset(tokenHash) {
    const rec = this.passwordResets.find(r => r.tokenHash === tokenHash && !r.usedAt && Date.parse(r.expiresAt) > Date.now());
    if (!rec) return null;
    rec.usedAt = new Date().toISOString();
    this._save('passwordResets');
    return rec;
  }

  // --- Platform OAuth Config ---
  async getOAuthConfig() {
    return loadJSON(this.files.oauthConfig, null);
  }
  async saveOAuthConfig(config) {
    saveJSON(this.files.oauthConfig, config);
  }

  // --- Products ---
  async listProducts({ sellerId = null, search = '' } = {}) {
    let list = this.products.filter(p => p.sellerId === 'ALL' || (sellerId && p.sellerId === sellerId));
    if (search) {
      const q = search.toLowerCase().trim();
      list = list.filter(p =>
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q))
      );
    }
    return list;
  }
  async findProductByIdentifier(identifier, sellerId = null) {
    const ident = String(identifier || '').toLowerCase().trim();
    return this.products.find(p =>
      (p.sellerId === 'ALL' || (sellerId && p.sellerId === sellerId)) &&
      ((p.sku && p.sku.toLowerCase() === ident) ||
       (p.id && p.id.toLowerCase() === ident) ||
       (p.name && p.name.toLowerCase() === ident))
    ) || null;
  }
  async findMatchingProductForOrder(sellerId, { productId, sku, name }) {
    const cleanSku = String(sku || '').trim().toLowerCase();
    const cleanName = String(name || '').trim().toLowerCase();
    const matches = p =>
      (productId && p.id === productId) ||
      (cleanSku && p.sku && p.sku.toLowerCase() === cleanSku) ||
      (cleanName && String(p.name || '').toLowerCase() === cleanName);
    return this.products.find(p => p.sellerId === sellerId && matches(p)) ||
      this.products.find(p => p.sellerId === 'ALL' && matches(p)) || null;
  }
  async createProduct(product) {
    this.products.unshift(product);
    this._save('products');
    return product;
  }
  async saveProduct(product) {
    const idx = this.products.findIndex(p => p.id === product.id);
    if (idx === -1) this.products.unshift(product);
    else this.products[idx] = product;
    this._save('products');
    return product;
  }
  async deleteProduct(idOrSku, sellerId) {
    const ident = String(idOrSku || '').toUpperCase();
    const idx = this.products.findIndex(p =>
      p.sellerId === sellerId &&
      (p.id === idOrSku || (p.sku && p.sku.toUpperCase() === ident))
    );
    if (idx === -1) return null;
    const removed = this.products.splice(idx, 1)[0];
    this._save('products');
    return removed;
  }

  // --- Orders ---
  async listOrdersBySeller(sellerId) {
    return this.orders.filter(o => o.sellerId === sellerId);
  }
  async hasPendingOrders() {
    return this.orders.some(o => o.status === 'PENDING');
  }
  async findOrderByToken(token) {
    const clean = String(token || '').trim().toLowerCase();
    return this.orders.find(o => o.token && o.token.toLowerCase() === clean) || null;
  }
  async findOrderByIdentifier(tokenOrRef, sellerId = null) {
    if (!tokenOrRef) return null;
    const clean = String(tokenOrRef).trim().toLowerCase();
    return this.orders.find(o => {
      if (sellerId && o.sellerId !== sellerId) return false;
      return (o.token && o.token.toLowerCase() === clean) ||
        (o.invoiceId && o.invoiceId.toLowerCase() === clean) ||
        (o.ref && String(o.ref).toLowerCase() === clean) ||
        (o.storeRef && String(o.storeRef).toLowerCase() === clean) ||
        (o.id && String(o.id).toLowerCase() === clean);
    }) || null;
  }
  async findOrderByClientRequestId(sellerId, clientRequestId) {
    if (!clientRequestId) return null;
    return this.orders.find(o => o.sellerId === sellerId && o.clientRequestId === clientRequestId) || null;
  }
  async findPaidOrderByUtr(sellerId, utr, excludeOrderId = null) {
    if (!utr) return null;
    return this.orders.find(o => o.sellerId === sellerId && o.status === 'PAID' && o.utr === utr && o.id !== excludeOrderId) || null;
  }
  async findPendingOrders(sellerId) {
    const result = [];
    for (const o of this.orders) {
      if (o.sellerId !== sellerId || o.status !== 'PENDING') continue;
      if (o.expiresAt && Date.parse(o.expiresAt) <= Date.now()) {
        o.status = 'EXPIRED';
        o.paymentStatus = 'EXPIRED';
        this._save('orders');
        continue;
      }
      if (!isOrderClosed(o)) result.push(o);
    }
    return result;
  }
  async findOrdersByTokenOrRefAcrossStores(token, orderRef) {
    return this.orders.filter(o =>
      token ? (o.token && o.token.toLowerCase() === token.toLowerCase()) :
        [o.ref, o.storeRef].some(ref => ref && String(ref).toLowerCase() === String(orderRef).toLowerCase())
    );
  }
  async nextOrderIdentifiers(sellerId, brandName) {
    const storeOrders = this.orders.filter(o => o.sellerId === sellerId);
    const storePrefix = (brandName || 'ORD').replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase() || 'ORD';
    let maxRefSeq = 0;
    for (const o of storeOrders) {
      const refStr = String(o.storeRef || o.ref || '');
      const m = refStr.match(new RegExp(`^${storePrefix}-(\\d+)`, 'i'));
      if (m) maxRefSeq = Math.max(maxRefSeq, parseInt(m[1], 10));
    }
    let nextSeq = Math.max(storeOrders.length + 1, maxRefSeq + 1);
    let storeRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`;
    while (storeOrders.some(o => o.storeRef === storeRef || o.ref === storeRef)) {
      nextSeq++;
      storeRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`;
    }

    const year = new Date().getFullYear();
    const invPrefix = `INV-${year}-`;
    let maxInv = 0;
    for (const o of storeOrders) {
      if (o.invoiceId && o.invoiceId.startsWith(invPrefix)) {
        const num = parseInt(o.invoiceId.replace(invPrefix, ''), 10);
        if (num > maxInv) maxInv = num;
      }
    }
    let nextInv = Math.max(storeOrders.length + 1, maxInv + 1);
    let invoiceId = `${invPrefix}${String(nextInv).padStart(3, '0')}`;
    while (storeOrders.some(o => o.invoiceId === invoiceId)) {
      nextInv++;
      invoiceId = `${invPrefix}${String(nextInv).padStart(3, '0')}`;
    }
    return { storeRef, invoiceId };
  }
  async createOrder(order) {
    this.orders.unshift(order);
    this._save('orders');
    return order;
  }
  async saveOrder(order) {
    normalizeOrderSteps(order);
    const idx = this.orders.findIndex(o => o.id === order.id || o.token === order.token);
    if (idx !== -1) this.orders[idx] = order;
    this._save('orders');
    return order;
  }

  // --- Unmatched Credits ---
  async listUnmatchedCredits(sellerId, limit = 50) {
    return this.unmatchedCredits
      .filter(c => c.sellerId === sellerId && !c.allocatedOrderId)
      .slice(0, limit);
  }
  async findUnmatchedCredit({ sellerId, utr = null, sourceId = null, unallocatedOnly = false }) {
    return this.unmatchedCredits.find(c => {
      if (c.sellerId !== sellerId) return false;
      if (unallocatedOnly && c.allocatedOrderId) return false;
      return (utr && c.utr === utr) || (sourceId && c.sourceId === sourceId);
    }) || null;
  }
  async saveUnmatchedCredit(credit) {
    const idx = this.unmatchedCredits.findIndex(c => c.id === credit.id);
    if (idx === -1) this.unmatchedCredits.unshift(credit);
    else this.unmatchedCredits[idx] = credit;
    this._save('unmatchedCredits');
    return credit;
  }
}

module.exports = { JsonStore, loadJSON, saveJSON };

