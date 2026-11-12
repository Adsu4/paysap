-- PaySap PostgreSQL Initial Schema (001)
-- Supports transactional multi-tenant UPI checkout, inventory locking, and bank receipt ledger.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  owner_name TEXT,
  brand_category TEXT NOT NULL DEFAULT 'Retail & Goods',
  phone TEXT NOT NULL DEFAULT '',
  upi_id TEXT NOT NULL,
  theme_id TEXT NOT NULL DEFAULT 'lavender',
  brand_color TEXT NOT NULL DEFAULT '#4f46e5',
  store_location TEXT,
  store_instagram TEXT,
  store_logo TEXT,
  assurance_text TEXT NOT NULL DEFAULT 'Payment goes directly to the store. Contact the store for delivery help.',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seller_banking_configs (
  seller_id TEXT PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  bank_code TEXT NOT NULL DEFAULT 'ICICI',
  bank_name TEXT NOT NULL DEFAULT 'ICICI Bank',
  verified_sender_email TEXT NOT NULL DEFAULT 'bankingalerts@icicibank.com',
  imap_host TEXT NOT NULL DEFAULT 'imap.gmail.com',
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_user TEXT,
  encrypted_imap_password TEXT,
  monitoring_active BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_mode TEXT NOT NULL DEFAULT 'review' CHECK (confirmation_mode IN ('review', 'automatic')),
  google_connected BOOLEAN NOT NULL DEFAULT FALSE,
  google_connected_email TEXT,
  encrypted_google_refresh_token TEXT,
  encrypted_google_access_token TEXT,
  google_token_expires_at BIGINT,
  google_connected_at TIMESTAMPTZ,
  google_disconnected_at TIMESTAMPTZ,
  gmail_page_token TEXT,
  inspected_gmail_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  imap_uid_validity TEXT,
  inspected_imap_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at TIMESTAMPTZ,
  last_successful_check_at TIMESTAMPTZ,
  last_matched_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS salesmen (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  stock_access BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_salesmen_seller_id ON salesmen(seller_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'OWNER',
  salesman_id TEXT,
  salesman_name TEXT,
  stock_access BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_seller_id ON sessions(seller_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  nonce TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_seller_id ON password_resets(seller_id);

CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  sku TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General Products',
  price_paise BIGINT NOT NULL CHECK (price_paise > 0),
  stock INTEGER,
  low_stock_alert INTEGER NOT NULL DEFAULT 5,
  description TEXT,
  notes TEXT,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_seller_id ON products(seller_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  store_ref TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  client_request_id TEXT,
  request_digest TEXT,
  customer_session_key TEXT,
  salesman_id TEXT,
  salesman_name TEXT,
  product_id TEXT,
  sku TEXT,
  product_image TEXT,
  brand_name TEXT NOT NULL,
  brand_category TEXT,
  theme_id TEXT NOT NULL DEFAULT 'lavender',
  brand_color TEXT NOT NULL DEFAULT '#4f46e5',
  store_location TEXT,
  store_instagram TEXT,
  store_logo TEXT,
  assurance_text TEXT,
  store_phone TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  item_description TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_paise BIGINT NOT NULL,
  discount_paise BIGINT NOT NULL DEFAULT 0,
  shipping_paise BIGINT NOT NULL DEFAULT 0,
  amount_paise BIGINT NOT NULL,
  payable_paise BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  internal_notes TEXT NOT NULL DEFAULT '',
  customer_instructions TEXT NOT NULL DEFAULT '',
  upi_id TEXT NOT NULL,
  upi_intent_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payment_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  payment_method TEXT,
  payment_ref TEXT,
  utr TEXT,
  customer_reported_utr TEXT,
  customer_reported_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  verified_via TEXT,
  match_reason TEXT,
  fulfillment_issue TEXT,
  is_out_of_stock BOOLEAN NOT NULL DEFAULT FALSE,
  stock_decremented BOOLEAN NOT NULL DEFAULT FALSE,
  address JSONB,
  dispatch_status TEXT NOT NULL DEFAULT 'PENDING',
  tracking_number TEXT,
  cancelled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  refund_details JSONB,
  steps JSONB NOT NULL DEFAULT '{}'::jsonb,
  activity JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_step TEXT NOT NULL DEFAULT 'WAITING_FOR_USER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, store_ref),
  UNIQUE (seller_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_seller_created ON orders(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller_status ON orders(seller_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_seller_client_req ON orders(seller_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_seller_paid_utr ON orders(seller_id, utr) WHERE status = 'PAID' AND utr IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS unmatched_credits (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  amount_paise BIGINT NOT NULL,
  utr TEXT,
  source_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  authentication_verified BOOLEAN NOT NULL DEFAULT FALSE,
  order_token TEXT,
  order_ref TEXT,
  candidate_order_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  allocated_order_id TEXT,
  review_reason TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unmatched_credits_seller ON unmatched_credits(seller_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unmatched_credits_seller_utr ON unmatched_credits(seller_id, utr) WHERE utr IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unmatched_credits_seller_source ON unmatched_credits(seller_id, source_id) WHERE source_id IS NOT NULL;

