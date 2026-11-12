const express = require('express');
const crypto = require('crypto');
const {
  sanitizeInput,
  hashPassword,
  verifyPassword,
  createStaffPin,
  verifyStaffPin,
  sanitizeSellerForRole,
  hasStockAccess,
  storeTheme
} = require('../utils/security');
const { getAuthCookieHeader, clearAuthCookieHeader, extractToken } = require('../middleware/auth');
const { authLimiter, recoveryLimiter, LoginLockoutTracker } = require('../middleware/rateLimit');

function createAuthRoutes({ store, auth }) {
  const router = express.Router();
  const ownerLockout = new LoginLockoutTracker({ maxFailures: 5, baseLockMs: 60 * 1000 });
  const staffLockout = new LoginLockoutTracker({ maxFailures: 5, baseLockMs: 2 * 60 * 1000 });

  router.get('/api/public/stores', async (req, res, next) => {
    try {
      const lookup = String(req.query.storeId || req.query.email || '').trim().toLowerCase();
      const stores = await store.findPublicStores(lookup);
      res.json({ success: true, stores });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/register', authLimiter, async (req, res, next) => {
    try {
      const {
        email,
        password,
        brandName,
        ownerName,
        brandCategory = 'Luxury Pret & Festive',
        phone,
        upiId
      } = req.body;

      if ([email, password, brandName, upiId].some(v => typeof v !== 'string' || !v.trim()) ||
          [ownerName, phone, brandCategory].some(v => v !== undefined && typeof v !== 'string')) {
        return res.status(400).json({ error: 'Store email, store password, brand name, and direct UPI ID are required.' });
      }

      const cleanEmail = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254 || brandName.length > 150 ||
          (req.body.salesmen && (!Array.isArray(req.body.salesmen) || req.body.salesmen.length > 50))) {
        return res.status(400).json({ error: 'Enter a valid email, store name, and staff list.' });
      }
      if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
        return res.status(400).json({ error: 'Use a store password between 10 and 200 characters.' });
      }

      const cleanUpi = upiId.trim();
      if (!cleanUpi.includes('@')) {
        return res.status(400).json({ error: 'Please enter a valid UPI VPA ID (e.g. store@okhdfcbank or yourname@upi).' });
      }

      const requestedStaff = Array.isArray(req.body.salesmen) ? req.body.salesmen : [];
      if (requestedStaff.some(sm => !sm || typeof sm.name !== 'string' || !sm.name.trim() || !/^\d{4}$/.test(String(sm.pin || '').trim()))) {
        return res.status(400).json({ error: 'Each staff member needs a name and an explicit 4-digit PIN.' });
      }
      if (new Set(requestedStaff.map(sm => String(sm.pin).trim())).size !== requestedStaff.length) {
        return res.status(400).json({ error: 'Each staff member must have a different PIN.' });
      }

      const result = await store.withTransaction(async tx => {
        const existing = await tx.findSellerByEmail(cleanEmail);
        if (existing) return { conflict: true };

        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = hashPassword(password, salt);
        const storeId = `seller_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const initialSalesmen = requestedStaff.map((sm, idx) => ({
          id: `sm_${Date.now()}_${idx + 1}`,
          name: sanitizeInput(sm.name.trim()),
          ...createStaffPin(String(sm.pin).trim()),
          stockAccess: false,
          createdAt: new Date().toISOString()
        }));

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
          ...storeTheme(null),
          createdAt: new Date().toISOString(),
          salesmen: initialSalesmen
        };

        await tx.createSeller(newSeller);
        const token = await tx.createSession(newSeller.id, 'OWNER');
        return { newSeller, token };
      });

      if (result.conflict) {
        return res.status(409).json({ error: 'An account with this email address already exists. Please sign in.' });
      }

      res.setHeader('Set-Cookie', getAuthCookieHeader(result.token));
      res.status(201).json({
        success: true,
        message: 'Store registered successfully on PaySap!',
        token: result.token,
        role: 'OWNER',
        seller: sanitizeSellerForRole(result.newSeller, 'OWNER')
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/login', authLimiter, async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        return res.status(400).json({ error: 'Store email/ID and store password are required.' });
      }

      const cleanEmail = email.trim().toLowerCase();
      const lockStatus = ownerLockout.check(cleanEmail);
      if (lockStatus.blocked) {
        return res.status(429).json({
          error: `Too many failed sign-in attempts for this store. Try again in ${lockStatus.retryAfterSec} seconds.`
        });
      }

      const seller = await store.findSellerByEmailOrId(cleanEmail);
      if (!seller || !verifyPassword(password, seller.salt, seller.passwordHash)) {
        ownerLockout.recordFailure(cleanEmail);
        return res.status(401).json({ error: 'Invalid store email or password. Please verify your credentials.' });
      }

      ownerLockout.clear(cleanEmail);
      const token = await store.createSession(seller.id, 'OWNER');
      res.setHeader('Set-Cookie', getAuthCookieHeader(token));

      res.json({
        success: true,
        message: `Welcome back to ${seller.brandName} Master Dashboard!`,
        token,
        role: 'OWNER',
        seller: sanitizeSellerForRole(seller, 'OWNER')
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/salesman-login', authLimiter, async (req, res, next) => {
    try {
      const { storeId, salesmanId, pin } = req.body;
      if (typeof storeId !== 'string' || !storeId.trim() || !pin) {
        return res.status(400).json({ error: 'Please select a store and enter your 4-digit PIN.' });
      }

      const seller = await store.findSellerByEmailOrId(storeId.trim());
      if (!seller) {
        return res.status(404).json({ error: 'Store not found. Please select a valid store.' });
      }

      if (!seller.salesmen || seller.salesmen.length === 0) {
        return res.status(400).json({ error: 'No salesmen registered for this store. Please ask the store owner to add your PIN.' });
      }

      const lockKey = `${seller.id}:${salesmanId || 'any'}`;
      const lockStatus = staffLockout.check(lockKey);
      if (lockStatus.blocked) {
        return res.status(429).json({
          error: `Too many failed PIN attempts. Try again in ${lockStatus.retryAfterSec} seconds.`
        });
      }

      const cleanPin = String(pin).trim();
      let salesman = null;
      if (salesmanId) {
        salesman = seller.salesmen.find(sm => sm.id === salesmanId);
      } else {
        salesman = seller.salesmen.find(sm => verifyStaffPin(sm, cleanPin));
      }

      if (!salesman || !verifyStaffPin(salesman, cleanPin)) {
        staffLockout.recordFailure(lockKey);
        return res.status(401).json({ error: salesman ? `Incorrect 4-digit PIN for ${salesman.name}` : 'Salesman not found or invalid PIN.' });
      }

      staffLockout.clear(lockKey);
      if (salesman.pin) {
        Object.assign(salesman, createStaffPin(cleanPin));
        delete salesman.pin;
        await store.saveSeller(seller);
      }

      const token = await store.createSession(seller.id, 'SALESMAN', salesman);
      res.setHeader('Set-Cookie', getAuthCookieHeader(token));

      res.json({
        success: true,
        message: `Logged in as ${salesman.name}!`,
        token,
        role: 'SALESMAN',
        salesman: {
          id: salesman.id,
          name: salesman.name,
          stockAccess: salesman.stockAccess === true
        },
        stockAccess: salesman.stockAccess === true,
        seller: sanitizeSellerForRole(seller, 'SALESMAN')
      });
    } catch (err) {
      next(err);
    }
  });

  // Owner password recovery: generates a time-limited single-use reset token.
  // Never discloses whether an email is registered or leaks raw reset tokens in public API responses.
  router.post('/api/auth/forgot-password', recoveryLimiter, async (req, res, next) => {
    try {
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid store owner email address.' });
      }
      const seller = await store.findSellerByEmail(email);
      if (seller) {
        const rawToken = crypto.randomBytes(24).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await store.createPasswordReset(seller.id, tokenHash, expiresAt);

        if (process.env.PASSWORD_RESET_WEBHOOK_URL) {
          fetch(process.env.PASSWORD_RESET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: seller.email, sellerId: seller.id, brandName: seller.brandName, resetToken: rawToken, expiresAt }),
            signal: AbortSignal.timeout(4000)
          }).catch(err => console.warn('[Password Reset Webhook] Delivery failed:', err.message));
        } else if (process.env.NODE_ENV !== 'production') {
          console.info(`[Password Reset] Dev reset token generated for ${seller.email} (expires ${expiresAt}).`);
        }
      }
      res.json({
        success: true,
        message: 'If an owner account matches that email, password reset instructions have been issued.'
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/reset-password', recoveryLimiter, async (req, res, next) => {
    try {
      const { token, newPassword } = req.body;
      if (typeof token !== 'string' || !/^[a-f0-9]{32,128}$/i.test(token.trim())) {
        return res.status(400).json({ error: 'Enter a valid password reset token.' });
      }
      if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 200) {
        return res.status(400).json({ error: 'Use a new password between 10 and 200 characters.' });
      }
      const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
      const updated = await store.withTransaction(async tx => {
        const reset = await tx.consumePasswordReset(tokenHash);
        if (!reset) return null;
        const seller = await tx.findSellerById(reset.sellerId);
        if (!seller) return null;
        const newSalt = crypto.randomBytes(16).toString('hex');
        seller.salt = newSalt;
        seller.passwordHash = hashPassword(newPassword, newSalt);
        await tx.saveSeller(seller);
        await tx.deleteSessionsBySeller(seller.id);
        return seller;
      });
      if (!updated) {
        return res.status(400).json({ error: 'This reset token is invalid or has expired.' });
      }
      res.setHeader('Set-Cookie', clearAuthCookieHeader());
      res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/me', async (req, res, next) => {
    try {
      const token = extractToken(req);
      const seller = await auth.getSellerByToken(token);
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
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/logout', async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (token) await store.deleteSession(token);
      res.setHeader('Set-Cookie', clearAuthCookieHeader());
      res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/profile', auth.requireOwner, async (req, res, next) => {
    try {
      const seller = await store.findSellerById(req.seller.id);
      if (!seller) return res.status(404).json({ error: 'Seller not found.' });
      const { brandName, ownerName, brandCategory, phone, upiId } = req.body;
      if (brandName) seller.brandName = sanitizeInput(brandName.trim());
      if (ownerName) seller.ownerName = sanitizeInput(ownerName.trim());
      if (brandCategory) seller.brandCategory = sanitizeInput(brandCategory.trim());
      if (phone) seller.phone = phone.replace(/\D/g, '').slice(-10);
      if (upiId && upiId.includes('@')) seller.upiId = upiId.trim();
      await store.saveSeller(seller);
      res.json({ success: true, seller: sanitizeSellerForRole(seller, 'OWNER') });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRoutes };

