const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { isOrderClosed, normalizeOrderSteps } = require('../utils/security');

function mapSellerRow(row, bankingRow, salesmenRows) {
  if (!row) return null;
  const bankingAutomation = bankingRow ? {
    bankCode: bankingRow.bank_code,
    bankName: bankingRow.bank_name,
    verifiedSenderEmail: bankingRow.verified_sender_email,
    imapHost: bankingRow.imap_host,
    imapPort: bankingRow.imap_port,
    imapUser: bankingRow.imap_user || '',
    imapAppPassword: bankingRow.encrypted_imap_password || '',
    monitoringActive: Boolean(bankingRow.monitoring_active),
    confirmationMode: bankingRow.confirmation_mode || 'review',
    googleOAuth: {
      connected: Boolean(bankingRow.google_connected),
      connectedEmail: bankingRow.google_connected_email || null,
      refreshToken: bankingRow.encrypted_google_refresh_token || null,
      accessToken: bankingRow.encrypted_google_access_token || null,
      tokenExpiresAt: bankingRow.google_token_expires_at ? Number(bankingRow.google_token_expires_at) : null,
      connectedAt: bankingRow.google_connected_at ? new Date(bankingRow.google_connected_at).toISOString() : null,
      disconnectedAt: bankingRow.google_disconnected_at ? new Date(bankingRow.google_disconnected_at).toISOString() : null
    },
    gmailPageToken: bankingRow.gmail_page_token || null,
    inspectedGmailMessageIds: Array.isArray(bankingRow.inspected_gmail_ids) ? bankingRow.inspected_gmail_ids : [],
    imapUidValidity: bankingRow.imap_uid_validity || null,
    inspectedImapUids: Array.isArray(bankingRow.inspected_imap_uids) ? bankingRow.inspected_imap_uids : [],
    lastCheckedAt: bankingRow.last_checked_at ? new Date(bankingRow.last_checked_at).toISOString() : null,
    lastSuccessfulCheckAt: bankingRow.last_successful_check_at ? new Date(bankingRow.last_successful_check_at).toISOString() : null,
    lastMatchedAt: bankingRow.last_matched_at ? new Date(bankingRow.last_matched_at).toISOString() : null,
    lastError: bankingRow.last_error || null
  } : undefined;

  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    salt: row.salt,
    brandName: row.brand_name,
    ownerName: row.owner_name,
    brandCategory: row.brand_category,
    phone: row.phone,
    upiId: row.upi_id,
    themeId: row.theme_id,
    brandColor: row.brand_color,
    storeLocation: row.store_location,
    storeInstagram: row.store_instagram,
    storeLogo: row.store_logo,
    assuranceText: row.assurance_text,
    createdAt: new Date(row.created_at).toISOString(),
    salesmen: (salesmenRows || []).map(sm => ({
      id: sm.id,
      name: sm.name,
      pinHash: sm.pin_hash,
      pinSalt: sm.pin_salt,
      stockAccess: Boolean(sm.stock_access),
      createdAt: new Date(sm.created_at).toISOString()
    })),
    ...(bankingAutomation ? { bankingAutomation } : {})
  };
}

function mapProductRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    sellerId: row.seller_id,
    name: row.name,
    category: row.category,
    price: Number(row.price_paise) / 100,
    pricePaise: Number(row.price_paise),
    stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
    lowStockAlert: Number(row.low_stock_alert || 5),
    description: row.description || row.name,
    notes: row.notes || '',
    image: row.image || null,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapOrderRow(row) {
  if (!row) return null;
  const order = {
    id: row.id,
    token: row.token,
    checkoutToken: row.token,
    ref: row.store_ref,
    storeRef: row.store_ref,
    invoiceId: row.invoice_id,
    sellerId: row.seller_id,
    clientRequestId: row.client_request_id,
    requestDigest: row.request_digest,
    customerSessionKey: row.customer_session_key,
    salesmanId: row.salesman_id,
    salesmanName: row.salesman_name,
    productId: row.product_id,
    sku: row.sku,
    productImage: row.product_image,
    brandName: row.brand_name,
    brandCategory: row.brand_category,
    themeId: row.theme_id,
    brandColor: row.brand_color,
    storeLocation: row.store_location,
    storeInstagram: row.store_instagram,
    storeLogo: row.store_logo,
    assuranceText: row.assurance_text,
    storePhone: row.store_phone || '',
    customerName: row.customer_name || '',
    customerPhone: row.customer_phone || '',
    itemDescription: row.item_description,
    items: Array.isArray(row.items) ? row.items : [],
    subtotalAmount: Number(row.subtotal_paise) / 100,
    discountAmount: Number(row.discount_paise || 0) / 100,
    shippingAmount: Number(row.shipping_paise || 0) / 100,
    amount: Number(row.amount_paise) / 100,
    amountPaise: Number(row.amount_paise),
    payableAmount: Number(row.payable_paise) / 100,
    currency: row.currency || 'INR',
    internalNotes: row.internal_notes || '',
    customerInstructions: row.customer_instructions || '',
    notes: row.internal_notes || '',
    upiId: row.upi_id,
    upiIntentUrl: row.upi_intent_url,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    paymentRef: row.payment_ref,
    utr: row.utr,
    customerReportedUtr: row.customer_reported_utr,
    customerReportedAt: row.customer_reported_at ? new Date(row.customer_reported_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    verifiedVia: row.verified_via,
    matchReason: row.match_reason,
    fulfillmentIssue: row.fulfillment_issue,
    isOutOfStock: Boolean(row.is_out_of_stock),
    stockDecremented: Boolean(row.stock_decremented),
    address: row.address || null,
    dispatchStatus: row.dispatch_status || 'PENDING',
    trackingNumber: row.tracking_number || null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    refundDetails: row.refund_details || null,
    steps: row.steps || {},
    activity: Array.isArray(row.activity) ? row.activity : [],
    currentStep: row.current_step || 'WAITING_FOR_USER',
    createdAt: new Date(row.created_at).toISOString()
  };
  return normalizeOrderSteps(order);
}

function mapCreditRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sellerId: row.seller_id,
    amount: Number(row.amount_paise) / 100,
    amountPaise: Number(row.amount_paise),
    utr: row.utr,
    sourceId: row.source_id,
    receivedAt: new Date(row.received_at).toISOString(),
    authenticationVerified: Boolean(row.authentication_verified),
    orderToken: row.order_token,
    orderRef: row.order_ref,
    candidateOrderTokens: Array.isArray(row.candidate_order_tokens) ? row.candidate_order_tokens : [],
    allocatedOrderId: row.allocated_order_id,
    reviewReason: row.review_reason,
    reviewedBy: row.reviewed_by
  };
}

class PostgresStore {
  constructor(connectionString, { pool = null, client = null } = {}) {
    this.pool = pool || new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    this._client = client;
  }

  get db() {
    return this._client || this.pool;
  }

  async init() {
    const migrationPath = path.join(__dirname, '..', '..', 'migrations', '001_initial_schema.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await this.pool.query(sql);
      await this.pool.query(
        `INSERT INTO schema_migrations (version) VALUES ('001_initial_schema') ON CONFLICT (version) DO NOTHING`
      );
    }
  }

  async readyCheck() {
    await this.pool.query('SELECT 1');
  }

  async close() {
    if (!this._client && this.pool) await this.pool.end();
  }

  async withTransaction(fn) {
    if (this._client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PostgresStore(null, { pool: this.pool, client });
      const result = await fn(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async _hydrateSeller(sellerRow) {
    if (!sellerRow) return null;
    const [baRes, smRes] = await Promise.all([
      this.db.query('SELECT * FROM seller_banking_configs WHERE seller_id = $1', [sellerRow.id]),
      this.db.query('SELECT * FROM salesmen WHERE seller_id = $1 ORDER BY created_at ASC', [sellerRow.id])
    ]);
    return mapSellerRow(sellerRow, baRes.rows[0] || null, smRes.rows);
  }

  async listSellers() {
    const res = await this.db.query('SELECT * FROM sellers ORDER BY created_at ASC');
    return Promise.all(res.rows.map(r => this._hydrateSeller(r)));
  }

  async findSellerById(id) {
    const res = await this.db.query('SELECT * FROM sellers WHERE id = $1', [id]);
    return this._hydrateSeller(res.rows[0]);
  }

  async findSellerByEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    const res = await this.db.query('SELECT * FROM sellers WHERE LOWER(email) = $1', [clean]);
    return this._hydrateSeller(res.rows[0]);
  }

  async findSellerByEmailOrId(identifier) {
    const clean = String(identifier || '').trim().toLowerCase();
    const res = await this.db.query('SELECT * FROM sellers WHERE LOWER(email) = $1 OR LOWER(id) = $1', [clean]);
    return this._hydrateSeller(res.rows[0]);
  }

  async findPublicStores(lookup) {
    const clean = String(lookup || '').trim().toLowerCase();
    if (!clean) return [];
    const res = await this.db.query('SELECT * FROM sellers WHERE LOWER(email) = $1 OR LOWER(id) = $1', [clean]);
    const list = [];
    for (const row of res.rows) {
      const smRes = await this.db.query('SELECT id, name FROM salesmen WHERE seller_id = $1 ORDER BY created_at ASC', [row.id]);
      list.push({ id: row.id, brandName: row.brand_name, category: row.brand_category, salesmen: smRes.rows });
    }
    return list;
  }

  async createSeller(seller) {
    await this.db.query(
      `INSERT INTO sellers (id, email, password_hash, salt, brand_name, owner_name, brand_category, phone, upi_id, theme_id, brand_color, store_location, store_instagram, store_logo, assurance_text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        seller.id, seller.email, seller.passwordHash, seller.salt, seller.brandName, seller.ownerName || null,
        seller.brandCategory || 'Retail & Goods', seller.phone || '', seller.upiId,
        seller.themeId || 'lavender', seller.brandColor || '#4f46e5', seller.storeLocation || null,
        seller.storeInstagram || null, seller.storeLogo || null,
        seller.assuranceText || 'Payment goes directly to the store. Contact the store for delivery help.',
        seller.createdAt || new Date().toISOString()
      ]
    );
    await this._syncSalesmen(seller.id, seller.salesmen || []);
    if (seller.bankingAutomation) await this._upsertBanking(seller.id, seller.bankingAutomation);
    return seller;
  }

  async saveSeller(seller) {
    await this.db.query(
      `UPDATE sellers SET email=$2, password_hash=$3, salt=$4, brand_name=$5, owner_name=$6, brand_category=$7,
       phone=$8, upi_id=$9, theme_id=$10, brand_color=$11, store_location=$12, store_instagram=$13, store_logo=$14,
       assurance_text=$15, updated_at=NOW() WHERE id=$1`,
      [
        seller.id, seller.email, seller.passwordHash, seller.salt, seller.brandName, seller.ownerName || null,
        seller.brandCategory || 'Retail & Goods', seller.phone || '', seller.upiId,
        seller.themeId || 'lavender', seller.brandColor || '#4f46e5', seller.storeLocation || null,
        seller.storeInstagram || null, seller.storeLogo || null,
        seller.assuranceText || 'Payment goes directly to the store. Contact the store for delivery help.'
      ]
    );
    await this._syncSalesmen(seller.id, seller.salesmen || []);
    if (seller.bankingAutomation) await this._upsertBanking(seller.id, seller.bankingAutomation);
    return seller;
  }

  async _syncSalesmen(sellerId, salesmen) {
    const ids = salesmen.map(sm => sm.id);
    if (ids.length === 0) {
      await this.db.query('DELETE FROM salesmen WHERE seller_id = $1', [sellerId]);
    } else {
      await this.db.query('DELETE FROM salesmen WHERE seller_id = $1 AND NOT (id = ANY($2::text[]))', [sellerId, ids]);
    }
    for (const sm of salesmen) {
      await this.db.query(
        `INSERT INTO salesmen (id, seller_id, name, pin_hash, pin_salt, stock_access, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, pin_hash=EXCLUDED.pin_hash, pin_salt=EXCLUDED.pin_salt, stock_access=EXCLUDED.stock_access`,
        [sm.id, sellerId, sm.name, sm.pinHash || '', sm.pinSalt || '', Boolean(sm.stockAccess), sm.createdAt || new Date().toISOString()]
      );
    }
  }

  async _upsertBanking(sellerId, ba) {
    const oauth = ba.googleOAuth || {};
    await this.db.query(
      `INSERT INTO seller_banking_configs (
        seller_id, bank_code, bank_name, verified_sender_email, imap_host, imap_port, imap_user, encrypted_imap_password,
        monitoring_active, confirmation_mode, google_connected, google_connected_email,
        encrypted_google_refresh_token, encrypted_google_access_token, google_token_expires_at,
        google_connected_at, google_disconnected_at, gmail_page_token, inspected_gmail_ids,
        imap_uid_validity, inspected_imap_uids, last_checked_at, last_successful_check_at, last_matched_at, last_error, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())
      ON CONFLICT (seller_id) DO UPDATE SET
        bank_code=EXCLUDED.bank_code, bank_name=EXCLUDED.bank_name, verified_sender_email=EXCLUDED.verified_sender_email,
        imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port, imap_user=EXCLUDED.imap_user,
        encrypted_imap_password=EXCLUDED.encrypted_imap_password, monitoring_active=EXCLUDED.monitoring_active,
        confirmation_mode=EXCLUDED.confirmation_mode, google_connected=EXCLUDED.google_connected,
        google_connected_email=EXCLUDED.google_connected_email, encrypted_google_refresh_token=EXCLUDED.encrypted_google_refresh_token,
        encrypted_google_access_token=EXCLUDED.encrypted_google_access_token, google_token_expires_at=EXCLUDED.google_token_expires_at,
        google_connected_at=EXCLUDED.google_connected_at, google_disconnected_at=EXCLUDED.google_disconnected_at,
        gmail_page_token=EXCLUDED.gmail_page_token, inspected_gmail_ids=EXCLUDED.inspected_gmail_ids,
        imap_uid_validity=EXCLUDED.imap_uid_validity, inspected_imap_uids=EXCLUDED.inspected_imap_uids,
        last_checked_at=EXCLUDED.last_checked_at, last_successful_check_at=EXCLUDED.last_successful_check_at,
        last_matched_at=EXCLUDED.last_matched_at, last_error=EXCLUDED.last_error, updated_at=NOW()`,
      [
        sellerId, ba.bankCode || 'ICICI', ba.bankName || 'ICICI Bank', ba.verifiedSenderEmail || 'bankingalerts@icicibank.com',
        ba.imapHost || 'imap.gmail.com', Number(ba.imapPort || 993), ba.imapUser || null, ba.imapAppPassword || null,
        Boolean(ba.monitoringActive), ba.confirmationMode === 'automatic' ? 'automatic' : 'review',
        Boolean(oauth.connected), oauth.connectedEmail || null, oauth.refreshToken || null, oauth.accessToken || null,
        oauth.tokenExpiresAt || null, oauth.connectedAt || null, oauth.disconnectedAt || null,
        ba.gmailPageToken || null, JSON.stringify(ba.inspectedGmailMessageIds || []),
        ba.imapUidValidity || null, JSON.stringify(ba.inspectedImapUids || []),
        ba.lastCheckedAt || null, ba.lastSuccessfulCheckAt || null, ba.lastMatchedAt || null, ba.lastError || null
      ]
    );
  }

  // --- Sessions ---
  async createSession(sellerId, role = 'OWNER', salesman = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.query(
      `INSERT INTO sessions (token, seller_id, role, salesman_id, salesman_name, stock_access, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [token, sellerId, role || 'OWNER', salesman ? salesman.id : null, salesman ? salesman.name : null, salesman ? salesman.stockAccess === true : null, expiresAt]
    );
    return token;
  }

  async getSession(token) {
    if (!token) return null;
    const res = await this.db.query('SELECT * FROM sessions WHERE token = $1', [token]);
    const row = res.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
      await this.db.query('DELETE FROM sessions WHERE token = $1', [token]);
      return null;
    }
    return {
      sellerId: row.seller_id,
      role: row.role,
      salesmanId: row.salesman_id,
      salesmanName: row.salesman_name,
      stockAccess: row.stock_access,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString()
    };
  }

  async deleteSession(token) {
    if (token) await this.db.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async deleteSessionsBySeller(sellerId, { exceptToken = null, salesmanId = null } = {}) {
    if (salesmanId) {
      await this.db.query('DELETE FROM sessions WHERE seller_id = $1 AND salesman_id = $2', [sellerId, salesmanId]);
    } else if (exceptToken) {
      await this.db.query('DELETE FROM sessions WHERE seller_id = $1 AND token <> $2', [sellerId, exceptToken]);
    } else {
      await this.db.query('DELETE FROM sessions WHERE seller_id = $1', [sellerId]);
    }
  }

  async updateSessionsStockAccess(sellerId, salesmanId, stockAccess) {
    await this.db.query('UPDATE sessions SET stock_access = $3 WHERE seller_id = $1 AND salesman_id = $2', [sellerId, salesmanId, Boolean(stockAccess)]);
  }

  async cleanupExpiredSessions() {
    await this.db.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    await this.db.query('DELETE FROM oauth_states WHERE expires_at <= NOW()');
  }

  async saveOAuthState(nonce, sellerId, expiresAt) {
    await this.db.query('INSERT INTO oauth_states (nonce, seller_id, expires_at) VALUES ($1,$2,$3)', [nonce, sellerId, expiresAt]);
  }

  async consumeOAuthState(nonce) {
    const res = await this.db.query('DELETE FROM oauth_states WHERE nonce = $1 RETURNING *', [nonce]);
    const row = res.rows[0];
    if (!row) return null;
    return { sellerId: row.seller_id, expiresAt: new Date(row.expires_at).toISOString() };
  }

  async createPasswordReset(sellerId, tokenHash, expiresAt) {
    const id = `rst_${crypto.randomBytes(10).toString('hex')}`;
    await this.db.query('DELETE FROM password_resets WHERE seller_id = $1 OR expires_at <= NOW()', [sellerId]);
    await this.db.query(
      'INSERT INTO password_resets (id, seller_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [id, sellerId, tokenHash, expiresAt]
    );
    return { id, sellerId, tokenHash, expiresAt };
  }

  async consumePasswordReset(tokenHash) {
    const res = await this.db.query(
      `UPDATE password_resets SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [tokenHash]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, sellerId: row.seller_id, tokenHash: row.token_hash };
  }

  async getOAuthConfig() {
    const res = await this.db.query("SELECT value FROM platform_config WHERE key = 'google_oauth'");
    return res.rows[0] ? res.rows[0].value : null;
  }

  async saveOAuthConfig(config) {
    await this.db.query(
      `INSERT INTO platform_config (key, value, updated_at) VALUES ('google_oauth', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
  }

  // --- Products ---
  async listProducts({ sellerId = null, search = '' } = {}) {
    const params = [];
    let where = sellerId ? "(seller_id = 'ALL' OR seller_id = $1)" : "seller_id = 'ALL'";
    if (sellerId) params.push(sellerId);
    if (search) {
      params.push(`%${search.trim()}%`);
      const p = `$${params.length}`;
      where += ` AND (sku ILIKE ${p} OR name ILIKE ${p} OR COALESCE(description,'') ILIKE ${p} OR category ILIKE ${p})`;
    }
    const res = await this.db.query(`SELECT * FROM products WHERE ${where} ORDER BY created_at DESC`, params);
    return res.rows.map(mapProductRow);
  }

  async findProductByIdentifier(identifier, sellerId = null) {
    const clean = String(identifier || '').trim().toLowerCase();
    const res = sellerId
      ? await this.db.query(
        `SELECT * FROM products WHERE (seller_id = 'ALL' OR seller_id = $1)
         AND (LOWER(COALESCE(sku,'')) = $2 OR LOWER(id) = $2 OR LOWER(name) = $2) LIMIT 1`,
        [sellerId, clean]
      )
      : await this.db.query(
        `SELECT * FROM products WHERE seller_id = 'ALL'
         AND (LOWER(COALESCE(sku,'')) = $1 OR LOWER(id) = $1 OR LOWER(name) = $1) LIMIT 1`,
        [clean]
      );
    return mapProductRow(res.rows[0]);
  }

  async findMatchingProductForOrder(sellerId, { productId, sku, name }) {
    const cleanSku = String(sku || '').trim().toLowerCase();
    const cleanName = String(name || '').trim().toLowerCase();
    const res = await this.db.query(
      `SELECT * FROM products WHERE seller_id IN ($1, 'ALL')
       AND (($2::text <> '' AND id = $2) OR ($3::text <> '' AND LOWER(COALESCE(sku,'')) = $3) OR ($4::text <> '' AND LOWER(name) = $4))
       ORDER BY CASE WHEN seller_id = $1 THEN 0 ELSE 1 END LIMIT 1`,
      [sellerId, productId || '', cleanSku, cleanName]
    );
    return mapProductRow(res.rows[0]);
  }

  async createProduct(product) {
    const pricePaise = Math.round(Number(product.price) * 100);
    await this.db.query(
      `INSERT INTO products (id, seller_id, sku, name, category, price_paise, stock, low_stock_alert, description, notes, image, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        product.id, product.sellerId, product.sku || null, product.name, product.category || 'General Products',
        pricePaise, product.stock === undefined ? null : product.stock, product.lowStockAlert || 5,
        product.description || product.name, product.notes || '', product.image || null, product.createdAt || new Date().toISOString()
      ]
    );
    return product;
  }

  async saveProduct(product) {
    const pricePaise = Math.round(Number(product.price) * 100);
    await this.db.query(
      `INSERT INTO products (id, seller_id, sku, name, category, price_paise, stock, low_stock_alert, description, notes, image, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, sku=EXCLUDED.sku, category=EXCLUDED.category,
       price_paise=EXCLUDED.price_paise, stock=EXCLUDED.stock, description=EXCLUDED.description, notes=EXCLUDED.notes, image=EXCLUDED.image`,
      [
        product.id, product.sellerId, product.sku || null, product.name, product.category || 'General Products',
        pricePaise, product.stock === undefined ? null : product.stock, product.lowStockAlert || 5,
        product.description || product.name, product.notes || '', product.image || null, product.createdAt || new Date().toISOString()
      ]
    );
    return product;
  }

  async deleteProduct(idOrSku, sellerId) {
    const res = await this.db.query(
      `DELETE FROM products WHERE seller_id = $1 AND (id = $2 OR UPPER(COALESCE(sku,'')) = UPPER($2)) RETURNING *`,
      [sellerId, idOrSku]
    );
    return mapProductRow(res.rows[0]);
  }

  // --- Orders ---
  async listOrdersBySeller(sellerId) {
    const res = await this.db.query('SELECT * FROM orders WHERE seller_id = $1 ORDER BY created_at DESC', [sellerId]);
    return res.rows.map(mapOrderRow);
  }

  async hasPendingOrders() {
    const res = await this.db.query("SELECT 1 FROM orders WHERE status = 'PENDING' LIMIT 1");
    return res.rowCount > 0;
  }

  async findOrderByToken(token) {
    const res = await this.db.query('SELECT * FROM orders WHERE LOWER(token) = LOWER($1) LIMIT 1', [token]);
    return mapOrderRow(res.rows[0]);
  }

  async findOrderByIdentifier(tokenOrRef, sellerId = null) {
    if (!tokenOrRef) return null;
    const lock = this._client ? ' FOR UPDATE' : '';
    const res = sellerId
      ? await this.db.query(
        `SELECT * FROM orders WHERE seller_id = $1 AND (LOWER(token)=LOWER($2) OR LOWER(invoice_id)=LOWER($2) OR LOWER(store_ref)=LOWER($2) OR LOWER(id)=LOWER($2)) LIMIT 1${lock}`,
        [sellerId, String(tokenOrRef).trim()]
      )
      : await this.db.query(
        `SELECT * FROM orders WHERE (LOWER(token)=LOWER($1) OR LOWER(invoice_id)=LOWER($1) OR LOWER(store_ref)=LOWER($1) OR LOWER(id)=LOWER($1)) LIMIT 1${lock}`,
        [String(tokenOrRef).trim()]
      );
    return mapOrderRow(res.rows[0]);
  }

  async findOrderByClientRequestId(sellerId, clientRequestId) {
    if (!clientRequestId) return null;
    const res = await this.db.query('SELECT * FROM orders WHERE seller_id = $1 AND client_request_id = $2 LIMIT 1', [sellerId, clientRequestId]);
    return mapOrderRow(res.rows[0]);
  }

  async findPaidOrderByUtr(sellerId, utr, excludeOrderId = null) {
    if (!utr) return null;
    const res = await this.db.query(
      "SELECT * FROM orders WHERE seller_id = $1 AND status = 'PAID' AND utr = $2 AND ($3::text IS NULL OR id <> $3) LIMIT 1",
      [sellerId, utr, excludeOrderId]
    );
    return mapOrderRow(res.rows[0]);
  }

  async findPendingOrders(sellerId) {
    await this.db.query(
      "UPDATE orders SET status = 'EXPIRED', payment_status = 'EXPIRED' WHERE seller_id = $1 AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()",
      [sellerId]
    );
    const res = await this.db.query(
      "SELECT * FROM orders WHERE seller_id = $1 AND status = 'PENDING' AND dispatch_status <> 'CANCELLED' ORDER BY created_at DESC",
      [sellerId]
    );
    return res.rows.map(mapOrderRow).filter(o => !isOrderClosed(o));
  }

  async findOrdersByTokenOrRefAcrossStores(token, orderRef) {
    const res = token
      ? await this.db.query('SELECT * FROM orders WHERE LOWER(token) = LOWER($1)', [token])
      : await this.db.query('SELECT * FROM orders WHERE LOWER(store_ref) = LOWER($1)', [String(orderRef || '')]);
    return res.rows.map(mapOrderRow);
  }

  async nextOrderIdentifiers(sellerId, brandName) {
    const res = await this.db.query('SELECT store_ref, invoice_id FROM orders WHERE seller_id = $1', [sellerId]);
    const storePrefix = (brandName || 'ORD').replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase() || 'ORD';
    let maxRef = 0;
    const year = new Date().getFullYear();
    const invPrefix = `INV-${year}-`;
    let maxInv = 0;
    const refs = new Set();
    const invs = new Set();
    for (const r of res.rows) {
      refs.add(r.store_ref);
      invs.add(r.invoice_id);
      const m = String(r.store_ref || '').match(new RegExp(`^${storePrefix}-(\\d+)`, 'i'));
      if (m) maxRef = Math.max(maxRef, parseInt(m[1], 10));
      if (String(r.invoice_id || '').startsWith(invPrefix)) {
        const n = parseInt(r.invoice_id.replace(invPrefix, ''), 10);
        if (n > maxInv) maxInv = n;
      }
    }
    let nextSeq = Math.max(res.rowCount + 1, maxRef + 1);
    let storeRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`;
    while (refs.has(storeRef)) { nextSeq++; storeRef = `${storePrefix}-${String(nextSeq).padStart(3, '0')}`; }

    let nextInv = Math.max(res.rowCount + 1, maxInv + 1);
    let invoiceId = `${invPrefix}${String(nextInv).padStart(3, '0')}`;
    while (invs.has(invoiceId)) { nextInv++; invoiceId = `${invPrefix}${String(nextInv).padStart(3, '0')}`; }
    return { storeRef, invoiceId };
  }

  async createOrder(order) {
    await this.db.query(
      `INSERT INTO orders (
        id, token, seller_id, store_ref, invoice_id, client_request_id, request_digest, customer_session_key,
        salesman_id, salesman_name, product_id, sku, product_image, brand_name, brand_category, theme_id, brand_color,
        store_location, store_instagram, store_logo, assurance_text, store_phone, customer_name, customer_phone,
        item_description, items, subtotal_paise, discount_paise, shipping_paise, amount_paise, payable_paise, currency,
        internal_notes, customer_instructions, upi_id, upi_intent_url, status, payment_status, dispatch_status,
        steps, activity, current_step, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
        $25,$26::jsonb,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40::jsonb,$41::jsonb,$42,$43
      )`,
      [
        order.id, order.token, order.sellerId, order.storeRef || order.ref, order.invoiceId,
        order.clientRequestId || null, order.requestDigest || null, order.customerSessionKey || null,
        order.salesmanId || null, order.salesmanName || null, order.productId || null, order.sku || null, order.productImage || null,
        order.brandName, order.brandCategory || null, order.themeId || 'lavender', order.brandColor || '#4f46e5',
        order.storeLocation || null, order.storeInstagram || null, order.storeLogo || null, order.assuranceText || null,
        order.storePhone || '', order.customerName || '', order.customerPhone || '', order.itemDescription,
        JSON.stringify(order.items || []), Math.round((order.subtotalAmount ?? order.amount) * 100),
        Math.round((order.discountAmount || 0) * 100), Math.round((order.shippingAmount || 0) * 100),
        order.amountPaise, Math.round((order.payableAmount ?? order.amount) * 100), order.currency || 'INR',
        order.internalNotes || '', order.customerInstructions || '', order.upiId, order.upiIntentUrl,
        order.status || 'PENDING', order.paymentStatus || 'AWAITING_PAYMENT', order.dispatchStatus || 'PENDING',
        JSON.stringify(order.steps || {}), JSON.stringify(order.activity || []), order.currentStep || 'WAITING_FOR_USER',
        order.createdAt || new Date().toISOString()
      ]
    );
    return order;
  }

  async saveOrder(order) {
    normalizeOrderSteps(order);
    await this.db.query(
      `UPDATE orders SET
        customer_session_key=$2, customer_name=$3, customer_phone=$4, product_id=$5, status=$6, payment_status=$7,
        payment_method=$8, payment_ref=$9, utr=$10, customer_reported_utr=$11, customer_reported_at=$12,
        paid_at=$13, verified_via=$14, match_reason=$15, fulfillment_issue=$16, is_out_of_stock=$17,
        stock_decremented=$18, address=$19::jsonb, dispatch_status=$20, tracking_number=$21, cancelled_at=$22,
        expires_at=$23, refund_details=$24::jsonb, steps=$25::jsonb, activity=$26::jsonb, current_step=$27
       WHERE id=$1`,
      [
        order.id, order.customerSessionKey || null, order.customerName || '', order.customerPhone || '',
        order.productId || null, order.status, order.paymentStatus, order.paymentMethod || null,
        order.paymentRef || null, order.utr || null, order.customerReportedUtr || null,
        order.customerReportedAt || null, order.paidAt || null, order.verifiedVia || null,
        order.matchReason || null, order.fulfillmentIssue || null, Boolean(order.isOutOfStock),
        Boolean(order.stockDecremented), order.address ? JSON.stringify(order.address) : null,
        order.dispatchStatus || 'PENDING', order.trackingNumber || null, order.cancelledAt || null,
        order.expiresAt || null, order.refundDetails ? JSON.stringify(order.refundDetails) : null,
        JSON.stringify(order.steps || {}), JSON.stringify(order.activity || []), order.currentStep || 'WAITING_FOR_USER'
      ]
    );
    return order;
  }

  // --- Unmatched Credits ---
  async listUnmatchedCredits(sellerId, limit = 50) {
    const res = await this.db.query(
      'SELECT * FROM unmatched_credits WHERE seller_id = $1 AND allocated_order_id IS NULL ORDER BY created_at DESC LIMIT $2',
      [sellerId, limit]
    );
    return res.rows.map(mapCreditRow);
  }

  async findUnmatchedCredit({ sellerId, utr = null, sourceId = null, unallocatedOnly = false }) {
    const clauses = ['seller_id = $1'];
    const params = [sellerId];
    if (unallocatedOnly) clauses.push('allocated_order_id IS NULL');
    const matchParts = [];
    if (utr) { params.push(utr); matchParts.push(`utr = $${params.length}`); }
    if (sourceId) { params.push(sourceId); matchParts.push(`source_id = $${params.length}`); }
    if (!matchParts.length) return null;
    clauses.push(`(${matchParts.join(' OR ')})`);
    const res = await this.db.query(`SELECT * FROM unmatched_credits WHERE ${clauses.join(' AND ')} LIMIT 1`, params);
    return mapCreditRow(res.rows[0]);
  }

  async saveUnmatchedCredit(credit) {
    await this.db.query(
      `INSERT INTO unmatched_credits (
        id, seller_id, amount_paise, utr, source_id, received_at, authentication_verified,
        order_token, order_ref, candidate_order_tokens, allocated_order_id, review_reason, reviewed_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        authentication_verified=EXCLUDED.authentication_verified,
        candidate_order_tokens=EXCLUDED.candidate_order_tokens,
        allocated_order_id=EXCLUDED.allocated_order_id,
        review_reason=EXCLUDED.review_reason,
        reviewed_by=EXCLUDED.reviewed_by`,
      [
        credit.id, credit.sellerId, credit.amountPaise || Math.round(Number(credit.amount) * 100),
        credit.utr || null, credit.sourceId || null, credit.receivedAt, Boolean(credit.authenticationVerified),
        credit.orderToken || null, credit.orderRef || null, JSON.stringify(credit.candidateOrderTokens || []),
        credit.allocatedOrderId || null, credit.reviewReason || null, credit.reviewedBy || null
      ]
    );
    return credit;
  }
}

module.exports = { PostgresStore };

