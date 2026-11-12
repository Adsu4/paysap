const express = require('express');
const path = require('path');
const { validateProductionEnvironment } = require('./config/env');
const { createStore } = require('./storage');
const { applySecurityMiddleware, csrfOriginGuard } = require('./middleware/security');
const { createAuthMiddleware } = require('./middleware/auth');
const { createMailboxService } = require('./services/mailboxService');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createStoreRoutes } = require('./routes/storeRoutes');
const { createProductRoutes } = require('./routes/productRoutes');
const { createOrderRoutes } = require('./routes/orderRoutes');
const { createBankRoutes } = require('./routes/bankRoutes');
const { createUtilityRoutes } = require('./routes/utilityRoutes');

function createApp(options = {}) {
  const store = options.store || createStore();
  const readyPromise = store.init();
  const app = express();

  applySecurityMiddleware(app);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(csrfOriginGuard);

  app.get('/dispatch.html', (req, res) => res.redirect(302, '/?tab=dispatch'));
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.use((req, res, next) => {
    readyPromise.then(() => next()).catch(next);
  });

  const auth = createAuthMiddleware(store);

  async function getGoogleCredentials() {
    let clientId = process.env.GOOGLE_CLIENT_ID || '';
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      try {
        const cfg = await store.getOAuthConfig();
        if (cfg) {
          if (!clientId && cfg.clientId) clientId = cfg.clientId;
          if (!clientSecret && cfg.clientSecret) clientSecret = cfg.clientSecret;
        }
      } catch (e) {
        console.warn('Could not read platform OAuth config:', e.message);
      }
    }
    return { clientId: (clientId || '').trim(), clientSecret: (clientSecret || '').trim() };
  }

  const mailboxService = createMailboxService({ store, getGoogleCredentials });

  app.use(createAuthRoutes({ store, auth }));
  app.use(createStoreRoutes({ store, auth, getGoogleCredentials }));
  app.use(createProductRoutes({ store, auth }));
  app.use(createOrderRoutes({
    store,
    auth,
    triggerBankingPoller: () => mailboxService.triggerBankingPoller()
  }));
  app.use(createBankRoutes({ store, auth, mailboxService, getGoogleCredentials }));
  app.use(createUtilityRoutes({ store, auth, publicDir }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status >= 500) console.error('[API Error]', error);
    res.status(status).json({
      error: status === 413
        ? 'This request is too large.'
        : status === 400
          ? 'The request could not be read. Check its format.'
          : 'The request could not be completed. Your changes may not have been saved; check the current status before retrying.'
    });
  });

  return { app, store, mailboxService, readyPromise, validateProductionEnvironment };
}

module.exports = { createApp };

