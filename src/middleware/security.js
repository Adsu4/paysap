const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');

function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (!raw) return (process.env.DYNO || process.env.WEBSITE_SITE_NAME) ? 1 : 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function applySecurityMiddleware(app) {
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', resolveTrustProxy());
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.use(compression());
  app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? (process.env.APP_URL || 'https://paysap.me') : true,
    credentials: true
  }));
}

// Protect cookie-authenticated state-changing endpoints against cross-site requests.
function csrfOriginGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const hasBearer = Boolean(req.headers.authorization || req.headers['x-auth-token']);
  if (hasBearer) return next();

  const cookieHeader = req.headers.cookie || '';
  if (!cookieHeader.includes('auth_token=')) return next();

  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }

  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const expectedHost = req.get('x-forwarded-host') || req.get('host');
      const appUrlHost = process.env.APP_URL ? new URL(process.env.APP_URL).host : null;
      if (originHost !== expectedHost && (!appUrlHost || originHost !== appUrlHost)) {
        return res.status(403).json({ error: 'Cross-origin state-changing request blocked.' });
      }
    } catch (_) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  return next();
}

module.exports = { applySecurityMiddleware, csrfOriginGuard };

