function getAuthCookieHeader(token) {
  const isProd = process.env.NODE_ENV === 'production';
  return `auth_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${isProd ? '; Secure' : ''}`;
}

function clearAuthCookieHeader() {
  const isProd = process.env.NODE_ENV === 'production';
  return `auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`;
}

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch (_) { return null; }
    }
  }
  return null;
}

function createAuthMiddleware(store) {
  async function getSellerByToken(token) {
    if (!token) return null;
    const session = await store.getSession(token);
    if (!session) return null;
    const seller = await store.findSellerById(session.sellerId);
    if (!seller) return null;
    return {
      ...seller,
      currentRole: session.role || 'OWNER',
      currentSalesmanId: session.salesmanId || null,
      currentSalesmanName: session.salesmanName || null
    };
  }

  async function requireAuth(req, res, next) {
    try {
      const token = extractToken(req);
      const seller = await getSellerByToken(token);
      if (!seller) {
        return res.status(401).json({ error: 'Authentication required. Please log in.' });
      }
      req.seller = seller;
      req.authToken = token;
      next();
    } catch (err) {
      next(err);
    }
  }

  function requireOwner(req, res, next) {
    requireAuth(req, res, () => {
      if (req.seller.currentRole !== 'OWNER') {
        return res.status(403).json({ error: 'Access denied. Master dashboard owner privileges required.' });
      }
      next();
    });
  }

  function requirePlatformAdmin(req, res, next) {
    requireOwner(req, res, () => {
      const allowed = (process.env.PLATFORM_ADMIN_SELLER_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
      if (allowed.includes(req.seller.id)) return next();
      return res.status(403).json({ error: 'Platform administrator access is required.' });
    });
  }

  async function optionalAuth(req, res, next) {
    try {
      const token = extractToken(req);
      if (token) {
        const seller = await getSellerByToken(token);
        if (seller) req.seller = seller;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  return {
    getSellerByToken,
    requireAuth,
    requireOwner,
    requirePlatformAdmin,
    optionalAuth
  };
}

module.exports = {
  getAuthCookieHeader,
  clearAuthCookieHeader,
  extractToken,
  createAuthMiddleware
};

