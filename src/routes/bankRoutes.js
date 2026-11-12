const express = require('express');
const crypto = require('crypto');
const {
  BANK_PRESETS,
  decryptSecret,
  encryptSecret,
  isAllowedImapEndpoint,
  getGoogleOAuthRedirectUri
} = require('../config/env');

function createBankRoutes({ store, auth, mailboxService, getGoogleCredentials }) {
  const router = express.Router();

  router.get('/api/payments/review', auth.requireOwner, async (req, res, next) => {
    try {
      const credits = await store.listUnmatchedCredits(req.seller.id, 50);
      res.json({
        success: true,
        credits: credits.map(c => ({
          id: c.id,
          amount: c.amount,
          utr: c.utr,
          receivedAt: c.receivedAt,
          authenticationVerified: c.authenticationVerified === true,
          reviewReason: c.reviewReason || 'REVIEW_REQUIRED'
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/webhook/bank-email', async (req, res, next) => {
    try {
      const sharedSecret = process.env.WEBHOOK_SHARED_SECRET;
      if (!sharedSecret) return res.status(503).json({ error: 'Bank webhook is not configured.' });
      const supplied = req.headers['x-webhook-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (typeof supplied !== 'string' ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(sharedSecret) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(sharedSecret))) {
        return res.status(401).json({ error: 'Invalid or missing webhook authentication.' });
      }

      const emailPayload = req.body || {};
      const parsed = mailboxService.parseBankEmail(emailPayload);

      let matchedSeller = null;
      if (req.query.storeId) matchedSeller = await store.findSellerById(req.query.storeId);
      if (!matchedSeller && req.headers['x-store-id']) matchedSeller = await store.findSellerById(req.headers['x-store-id']);
      if (!matchedSeller && (parsed.token || parsed.orderRef)) {
        const matches = await store.findOrdersByTokenOrRefAcrossStores(parsed.token, parsed.orderRef);
        const sellerIds = [...new Set(matches.map(o => o.sellerId))];
        if (sellerIds.length === 1) matchedSeller = await store.findSellerById(sellerIds[0]);
      }

      if (!matchedSeller) {
        return res.status(200).json({
          success: false,
          message: 'Email acknowledged, but target boutique store could not be authenticated. Pass ?storeId=YOUR_STORE_ID or include a matching reference.'
        });
      }

      const fromHeader = parsed.from || req.headers['from'] || req.headers['x-from'] || req.body.from || req.body.sender || '';
      const received = Date.parse(req.body.receivedAt);
      const result = await mailboxService.processBankCreditForStore(matchedSeller.id, parsed, fromHeader, {
        authenticated: req.body.emailAuthenticationPassed === true,
        sourceId: req.body.messageId || null,
        receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : new Date().toISOString()
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/seller/test-email-connection', auth.requireOwner, async (req, res) => {
    const { imapUser, imapAppPassword, imapHost, imapPort, bankCode, verifiedSenderEmail } = req.body;
    if (!isAllowedImapEndpoint(imapHost || 'imap.gmail.com', imapPort || 993)) {
      return res.status(400).json({ error: 'Use an approved IMAP provider on secure port 993.' });
    }
    const seller = await store.findSellerById(req.seller.id);
    const userToUse = (imapUser || (seller && seller.bankingAutomation && seller.bankingAutomation.imapUser) || (seller && seller.email) || '').trim();
    const storedPass = seller && seller.bankingAutomation && seller.bankingAutomation.imapAppPassword
      ? decryptSecret(seller.bankingAutomation.imapAppPassword)
      : '';
    const passwordToUse = (imapAppPassword || storedPass || '').trim();

    if (!userToUse || !passwordToUse) {
      return res.status(400).json({ error: 'Please enter both your Gmail address and 16-character App Password.' });
    }

    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: imapHost || 'imap.gmail.com',
      port: parseInt(imapPort, 10) || 993,
      secure: true,
      auth: { user: userToUse, pass: passwordToUse.replace(/\s+/g, '').trim() },
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
      res.status(400).json({ success: false, error: errMsg });
    }
  });

  router.post('/api/seller/test-ingest-email', auth.requireOwner, async (req, res, next) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Email simulation is disabled in production.' });
      }
      const { emailText, fromAddress } = req.body;
      if (!emailText || !emailText.trim()) {
        return res.status(400).json({ error: 'Please paste the bank alert email text.' });
      }
      const parsed = mailboxService.parseBankEmail(emailText);
      const seller = await store.findSellerById(req.seller.id);
      const from = fromAddress || seller?.bankingAutomation?.verifiedSenderEmail || 'bankingalerts@icicibank.com';
      const result = await mailboxService.processBankCreditForStore(req.seller.id, parsed, from);
      res.json({ ...result, parsed });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/admin/oauth-config', auth.requirePlatformAdmin, async (req, res, next) => {
    try {
      const creds = await getGoogleCredentials();
      res.json({
        configured: Boolean(creds.clientId && creds.clientSecret),
        clientId: creds.clientId ? `${creds.clientId.substring(0, 16)}...` : '',
        redirectUri: getGoogleOAuthRedirectUri(req)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/admin/oauth-config', auth.requirePlatformAdmin, async (req, res, next) => {
    try {
      const { clientId, clientSecret } = req.body;
      if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Both Google Client ID and Client Secret are required.' });
      }
      await store.saveOAuthConfig({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        updatedAt: new Date().toISOString()
      });
      res.json({
        success: true,
        message: 'Google OAuth credentials saved! Store owners can now connect Gmail with 1-click.'
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/google/connect', auth.requireOwner, async (req, res, next) => {
    try {
      const creds = await getGoogleCredentials();
      const redirectUri = getGoogleOAuthRedirectUri(req);
      if (!creds.clientId || !creds.clientSecret) {
        return res.status(400).json({
          error: 'Google OAuth credentials are not configured yet on this PaySap instance.',
          notConfigured: true,
          redirectUri
        });
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      const state = `${nonce}:${req.seller.id}`;
      await store.saveOAuthState(nonce, req.seller.id, new Date(Date.now() + 10 * 60 * 1000).toISOString());

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

      res.json({ success: true, authUrl, redirectUri });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/?tab=settings&google_error=${encodeURIComponent(error)}`);
    if (!code || !state) return res.redirect('/?tab=settings&google_error=Missing+authorization+code+or+state');

    const [stateNonce, sellerId] = String(state).split(':');
    const storedState = await store.consumeOAuthState(stateNonce);
    if (!storedState || storedState.sellerId !== sellerId) {
      return res.redirect('/?tab=settings&google_error=Invalid+state+parameter.+Possible+CSRF+attempt.');
    }
    if (new Date(storedState.expiresAt) < new Date()) {
      return res.redirect('/?tab=settings&google_error=OAuth+session+expired.+Please+try+again.');
    }

    const seller = await store.findSellerById(sellerId);
    if (!seller) return res.redirect('/?tab=settings&google_error=Store+session+not+found');

    const creds = await getGoogleCredentials();
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
        }),
        signal: AbortSignal.timeout(10000)
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return res.redirect(`/?tab=settings&google_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'Token exchange failed')}`);
      }

      let userEmail = seller.email || '';
      try {
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(10000)
        });
        if (userRes.ok) {
          const uInfo = await userRes.json();
          if (uInfo.email) userEmail = uInfo.email;
        }
      } catch (_) {}

      if (!seller.bankingAutomation) seller.bankingAutomation = {};
      const existingRefresh = seller.bankingAutomation.googleOAuth
        ? decryptSecret(seller.bankingAutomation.googleOAuth.refreshToken)
        : null;
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
      await store.saveSeller(seller);
      res.redirect('/?tab=settings&google_connected=success');
    } catch (err) {
      res.redirect(`/?tab=settings&google_error=${encodeURIComponent(err.message)}`);
    }
  });

  router.post('/api/auth/google/disconnect', auth.requireOwner, async (req, res, next) => {
    try {
      const seller = await store.findSellerById(req.seller.id);
      if (!seller) return res.status(404).json({ error: 'Seller not found.' });
      if (seller.bankingAutomation) {
        seller.bankingAutomation.googleOAuth = {
          connected: false,
          connectedEmail: null,
          refreshToken: null,
          accessToken: null,
          tokenExpiresAt: null,
          disconnectedAt: new Date().toISOString()
        };
        seller.bankingAutomation.monitoringActive = false;
        await store.saveSeller(seller);
      }
      res.json({ success: true, message: 'Google account disconnected successfully.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createBankRoutes };

