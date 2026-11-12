// PaySap - Multi-Seller Direct UPI Platform with Bank Email Verification
require('dotenv').config();
const { createApp } = require('./src/app');

const PORT = process.env.PORT || 3000;
const { app, store, mailboxService, readyPromise, validateProductionEnvironment } = createApp();

let ownedServer = null;
let sessionCleanupInterval = null;

function startServer(options = {}) {
  if (ownedServer) return ownedServer;
  validateProductionEnvironment();
  const port = options.port ?? PORT;
  const defaultHost = (process.env.DYNO || process.env.WEBSITE_SITE_NAME) ? '0.0.0.0' : '127.0.0.1';
  const host = options.host ?? process.env.HOST ?? defaultHost;
  ownedServer = app.listen(port, host, async () => {
    try {
      await readyPromise;
    } catch (err) {
      console.error('Failed to initialize data store:', err);
      process.exit(1);
    }
    mailboxService.startPoller();
    sessionCleanupInterval = setInterval(() => {
      store.cleanupExpiredSessions().catch(err => console.warn('Session cleanup failed:', err.message));
    }, 6 * 60 * 60 * 1000);
    sessionCleanupInterval.unref();
    console.log(`PaySap listening on ${host}:${ownedServer.address().port}`);
  });
  return ownedServer;
}

async function stopServer() {
  mailboxService.stopPoller();
  if (sessionCleanupInterval) clearInterval(sessionCleanupInterval);
  sessionCleanupInterval = null;
  const server = ownedServer;
  ownedServer = null;
  if (server) await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await store.close();
}

module.exports = { app, store, startServer, stopServer, validateProductionEnvironment };
if (require.main === module) startServer();
