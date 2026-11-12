// Preloaded only into the regression child server: fail any accidental external I/O.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host = options && typeof options === 'object' ? options.host : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (host && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('External network is disabled in regression tests');
  }
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    return Promise.reject(new Error('External network is disabled in regression tests'));
  }
  return originalFetch(input, init);
};
