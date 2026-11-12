const express = require('express');
const crypto = require('crypto');
const PaySapTheme = require('../../public/js/themes');
const { encryptSecret, isAllowedImapEndpoint } = require('../config/env');
const {
  sanitizeInput,
  hashPassword,
  verifyPassword,
  createStaffPin,
  verifyStaffPin,
  safeStaff,
  sanitizeSellerForRole,
  storeTheme
} = require('../utils/security');
const { emailAutoConfirmationEnabled } = require('../services/mailboxService');

function buildSafeSettings(safeStore, hasGoogleCredentials) {
  return {
    brandName: safeStore.brandName,
    ownerName: safeStore.ownerName,
    email: safeStore.email,
    phone: safeStore.phone,
    upiId: safeStore.upiId,
    brandCategory: safeStore.brandCategory,
    ...storeTheme(safeStore),
    storeLocation: safeStore.storeLocation || '',
    storeInstagram: safeStore.storeInstagram || '',
    storeLogo: safeStore.storeLogo || '',
    assuranceText: safeStore.assuranceText || 'Payment goes directly to the store. Contact the store for delivery help.',
    employeeCount: (safeStore.salesmen || []).length,
    salesmen: safeStore.salesmen || [],
    bankingAutomation: {
      bankCode: safeStore.bankingAutomation?.bankCode || 'ICICI',
      bankName: safeStore.bankingAutomation?.bankName || 'ICICI Bank',
      verifiedSenderEmail: safeStore.bankingAutomation?.verifiedSenderEmail || 'bankingalerts@icicibank.com',
      imapHost: safeStore.bankingAutomation?.imapHost || 'imap.gmail.com',
      imapPort: safeStore.bankingAutomation?.imapPort || 993,
      imapUser: safeStore.bankingAutomation?.imapUser || safeStore.email || '',
      hasAppPassword: Boolean(safeStore.bankingAutomation?.hasAppPassword),
      monitoringActive: safeStore.bankingAutomation?.monitoringActive === true,
      confirmationMode: emailAutoConfirmationEnabled(safeStore) ? 'automatic' : 'review',
      pollingEnabled: process.env.DISABLE_BANK_POLLING !== '1',
      lastSuccessfulCheckAt: safeStore.bankingAutomation?.lastSuccessfulCheckAt || null,
      lastCheckedAt: safeStore.bankingAutomation?.lastCheckedAt || null,
      lastMatchedAt: safeStore.bankingAutomation?.lastMatchedAt || null,
      lastError: safeStore.bankingAutomation?.lastError || null,
      googleOAuth: {
        connected: Boolean(safeStore.bankingAutomation?.googleOAuth?.connected),
        connectedEmail: safeStore.bankingAutomation?.googleOAuth?.connectedEmail || null,
        connectedAt: safeStore.bankingAutomation?.googleOAuth?.connectedAt || null
      },
      hasGoogleCredentials
    }
  };
}

function createStoreRoutes({ store, auth, getGoogleCredentials }) {
  const router = express.Router();

  router.get('/api/store/salesmen', auth.requireOwner, async (req, res, next) => {
    try {
      const seller = await store.findSellerById(req.seller.id);
      res.json({
        success: true,
        salesmen: ((seller && seller.salesmen) || []).map(safeStaff)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/store/salesmen', auth.requireOwner, async (req, res, next) => {
    try {
      const { name, pin, stockAccess = false } = req.body;
      if (typeof stockAccess !== 'boolean') return res.status(400).json({ error: 'Inventory access must be true or false.' });
      if (!name || !pin) return res.status(400).json({ error: 'Salesman name and 4-digit PIN are required.' });
      const cleanPin = String(pin).trim();
      if (!/^\d{4}$/.test(cleanPin)) return res.status(400).json({ error: 'PIN must contain exactly 4 digits.' });

      const result = await store.withTransaction(async tx => {
        const seller = await tx.findSellerById(req.seller.id);
        if (!seller) return { notFound: true };
        if (!seller.salesmen) seller.salesmen = [];
        const existingWithPin = seller.salesmen.find(sm => verifyStaffPin(sm, cleanPin));
        if (existingWithPin) {
          return { duplicate: existingWithPin.name };
        }
        const newSalesman = {
          id: `sm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name: sanitizeInput(name.trim()),
          ...createStaffPin(cleanPin),
          stockAccess,
          createdAt: new Date().toISOString()
        };
        seller.salesmen.push(newSalesman);
        await tx.saveSeller(seller);
        return { newSalesman };
      });

      if (result.notFound) return res.status(404).json({ error: 'Store not found.' });
      if (result.duplicate) {
        return res.status(400).json({ error: `Another staff member ("${result.duplicate}") already uses this PIN. Please assign a unique 4-digit PIN.` });
      }
      res.status(201).json({ success: true, salesman: safeStaff(result.newSalesman) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/api/store/salesmen/:id', auth.requireOwner, async (req, res, next) => {
    try {
      const { name, pin, stockAccess } = req.body;
      if (stockAccess !== undefined && typeof stockAccess !== 'boolean') {
        return res.status(400).json({ error: 'Inventory access must be true or false.' });
      }
      if (pin) {
        const cleanPin = String(pin).trim();
        if (!/^\d{4}$/.test(cleanPin)) return res.status(400).json({ error: 'PIN must contain exactly 4 digits.' });
      }

      const result = await store.withTransaction(async tx => {
        const seller = await tx.findSellerById(req.seller.id);
        if (!seller) return { notFound: 'Store not found.' };
        const smList = seller.salesmen || [];
        const sm = smList.find(item => item.id === req.params.id);
        if (!sm) return { notFound: 'Salesman not found.' };

        if (name) sm.name = sanitizeInput(name.trim());
        if (pin) {
          const cleanPin = String(pin).trim();
          const duplicate = smList.find(item => item.id !== req.params.id && verifyStaffPin(item, cleanPin));
          if (duplicate) return { duplicate: duplicate.name };
          Object.assign(sm, createStaffPin(cleanPin));
          delete sm.pin;
          await tx.deleteSessionsBySeller(req.seller.id, { salesmanId: req.params.id });
        }
        if (typeof stockAccess === 'boolean') {
          sm.stockAccess = stockAccess;
          await tx.updateSessionsStockAccess(req.seller.id, req.params.id, stockAccess);
        }
        await tx.saveSeller(seller);
        return { salesman: sm };
      });

      if (result.notFound) return res.status(404).json({ error: result.notFound });
      if (result.duplicate) {
        return res.status(400).json({ error: `Another staff member ("${result.duplicate}") already uses this PIN. Please assign a unique 4-digit PIN.` });
      }
      res.json({ success: true, salesman: safeStaff(result.salesman) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/store/salesmen/:id', auth.requireOwner, async (req, res, next) => {
    try {
      const result = await store.withTransaction(async tx => {
        const seller = await tx.findSellerById(req.seller.id);
        if (!seller) return { notFound: true };
        seller.salesmen = (seller.salesmen || []).filter(sm => sm.id !== req.params.id);
        await tx.saveSeller(seller);
        await tx.deleteSessionsBySeller(req.seller.id, { salesmanId: req.params.id });
        return { ok: true };
      });
      if (result.notFound) return res.status(404).json({ error: 'Store not found.' });
      res.json({ success: true, message: 'Salesman removed successfully.' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/store/settings', auth.requireOwner, async (req, res, next) => {
    try {
      const seller = await store.findSellerById(req.seller.id);
      if (!seller) return res.status(404).json({ error: 'Store not found.' });
      const safeStore = sanitizeSellerForRole(seller, 'OWNER');
      const creds = await getGoogleCredentials();
      res.json({
        success: true,
        settings: buildSafeSettings(safeStore, Boolean(creds.clientId))
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/api/store/settings', auth.requireOwner, async (req, res, next) => {
    try {
      const {
        brandName, ownerName, brandCategory, phone, upiId, currentPassword, newPassword,
        storeLocation, storeInstagram, storeLogo, assuranceText, bankingAutomation, themeId
      } = req.body;

      if (themeId !== undefined && !PaySapTheme.isValidId(themeId)) {
        return res.status(400).json({ error: 'Choose one of the available store themes.' });
      }
      if ([brandName, ownerName, brandCategory, phone, upiId, currentPassword, newPassword, storeLocation, storeInstagram, storeLogo, assuranceText].some(v => v !== undefined && typeof v !== 'string')) {
        return res.status(400).json({ error: 'Store settings must contain text values.' });
      }

      const result = await store.withTransaction(async tx => {
        const existing = await tx.findSellerById(req.seller.id);
        if (!existing) return { status: 404, error: 'Store not found.' };
        const draft = structuredClone(existing);

        if (themeId !== undefined) Object.assign(draft, storeTheme({ themeId }));
        if (storeLogo !== undefined) {
          const trimmedLogo = (storeLogo || '').trim();
          if (trimmedLogo && (/^(javascript|vbscript|data:(?!image))/i.test(trimmedLogo) || /<script/i.test(trimmedLogo))) {
            return { status: 400, error: 'Invalid or unsafe image URL.' };
          }
          draft.storeLogo = trimmedLogo;
        }

        if (newPassword) {
          if (!currentPassword) return { status: 400, error: 'Current password is required to set a new password.' };
          if (!verifyPassword(currentPassword, draft.salt, draft.passwordHash)) {
            return { status: 403, error: 'Current password is incorrect. Password change denied.' };
          }
          if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 200) {
            return { status: 400, error: 'Use a new password between 10 and 200 characters.' };
          }
          const newSalt = crypto.randomBytes(16).toString('hex');
          draft.salt = newSalt;
          draft.passwordHash = hashPassword(newPassword, newSalt);
        }

        if (brandName) draft.brandName = sanitizeInput(brandName.trim());
        if (ownerName) draft.ownerName = sanitizeInput(ownerName.trim());
        if (brandCategory) draft.brandCategory = sanitizeInput(brandCategory.trim());
        if (phone) draft.phone = phone.replace(/\D/g, '').slice(-10);
        if (upiId && upiId.includes('@')) draft.upiId = upiId.trim();
        if (storeLocation !== undefined) draft.storeLocation = sanitizeInput((storeLocation || '').trim());
        if (storeInstagram !== undefined) draft.storeInstagram = sanitizeInput((storeInstagram || '').trim().replace(/^@/, ''));
        if (assuranceText !== undefined) draft.assuranceText = sanitizeInput((assuranceText || '').trim());

        if (bankingAutomation && typeof bankingAutomation === 'object') {
          if (!isAllowedImapEndpoint(bankingAutomation.imapHost || 'imap.gmail.com', bankingAutomation.imapPort || 993)) {
            return { status: 400, error: 'Use an approved IMAP provider on secure port 993.' };
          }
          if (!draft.bankingAutomation) draft.bankingAutomation = {};
          const ba = draft.bankingAutomation;
          if (bankingAutomation.bankCode !== undefined) ba.bankCode = bankingAutomation.bankCode;
          if (bankingAutomation.bankName !== undefined) ba.bankName = bankingAutomation.bankName;
          if (bankingAutomation.verifiedSenderEmail !== undefined) ba.verifiedSenderEmail = (bankingAutomation.verifiedSenderEmail || '').trim().toLowerCase();
          if (bankingAutomation.imapHost !== undefined) ba.imapHost = (bankingAutomation.imapHost || 'imap.gmail.com').trim();
          if (bankingAutomation.imapPort !== undefined) ba.imapPort = parseInt(bankingAutomation.imapPort, 10) || 993;
          if (bankingAutomation.imapUser !== undefined) ba.imapUser = (bankingAutomation.imapUser || '').trim();
          if (bankingAutomation.imapAppPassword !== undefined && bankingAutomation.imapAppPassword.trim()) {
            ba.imapAppPassword = encryptSecret(bankingAutomation.imapAppPassword.trim());
          }
          if (bankingAutomation.monitoringActive !== undefined) {
            if (typeof bankingAutomation.monitoringActive !== 'boolean') return { status: 400, error: 'Monitoring must be on or off.' };
            ba.monitoringActive = bankingAutomation.monitoringActive;
          }
          if (bankingAutomation.confirmationMode !== undefined) {
            if (!['automatic', 'review'].includes(bankingAutomation.confirmationMode)) {
              return { status: 400, error: 'Choose automatic confirmation or owner review.' };
            }
            ba.confirmationMode = bankingAutomation.confirmationMode;
          }
        }

        await tx.saveSeller(draft);
        if (newPassword) {
          await tx.deleteSessionsBySeller(req.seller.id, { exceptToken: req.authToken });
        }
        return { draft };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      const safeStore = sanitizeSellerForRole(result.draft, 'OWNER');
      const creds = await getGoogleCredentials();
      res.json({
        success: true,
        message: 'Store settings updated successfully.',
        settings: buildSafeSettings(safeStore, Boolean(creds.clientId))
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createStoreRoutes };

