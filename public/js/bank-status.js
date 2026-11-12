(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaySapBankStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function describe(settings, now = Date.now()) {
    const mode = settings.confirmationMode === 'automatic' ? 'Automatic confirmation for verified matches.' : 'Payments require owner review.';
    const connection = settings.googleOAuth?.connected || settings.hasAppPassword;
    if (settings.pollingEnabled === false) return {title: 'Email checks disabled on this server', detail: 'Enable server email polling to check this mailbox. ' + mode, tone: 'paused'};
    if (!settings.monitoringActive) return {title: 'Email monitoring paused', detail: 'Turn on email checks and save to resume. ' + mode, tone: 'paused'};
    if (!connection) return {title: 'Connect a mailbox', detail: 'Connect Gmail or save mailbox app-password credentials. ' + mode, tone: 'paused'};
    if (settings.lastError) return {title: 'Email check needs attention', detail: settings.lastError + ' ' + mode, tone: 'error'};
    const time = Date.parse(settings.lastSuccessfulCheckAt);
    if (!Number.isFinite(time)) return {title: 'Waiting for the first successful email check', detail: 'The application server must be running. ' + mode, tone: 'paused'};
    if (now - time > 60000) return {title: 'Email checks have not updated recently', detail: 'Last successful check: ' + new Date(time).toLocaleString() + '. ' + mode, tone: 'paused'};
    return {title: 'Email monitoring is running', detail: 'Last successful check: ' + new Date(time).toLocaleTimeString() + '. ' + mode, tone: 'good'};
  }
  return {describe};
});
