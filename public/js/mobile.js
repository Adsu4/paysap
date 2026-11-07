// =============================================================================
// PaySap — Mobile layer for the seller app (index.html)
// -----------------------------------------------------------------------------
// Loaded after seller.js. Only touches the phone-only bottom dock
// (#mobileBottomNav is `md:hidden`) and only scrolls/focuses on phone widths,
// so desktop behaviour is unchanged.
// =============================================================================
(function () {
  const mq = window.matchMedia('(max-width: 767px)');
  const isPhone = () => mq.matches;
  const $ = (id) => document.getElementById(id);

  const NAV_ACTIVE = 'flex-1 py-1 flex flex-col items-center justify-center text-indigo-600 transition-colors font-bold cursor-pointer';
  const NAV_IDLE = 'flex-1 py-1 flex flex-col items-center justify-center text-slate-400 transition-colors font-medium cursor-pointer';

  let salesNavBuilt = false;
  let salesNavKey = 'sell';

  function scrollTopIfPhone() {
    if (isPhone()) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // Salesman dock: the default dock is owner-only (Overview / Dispatch /
  // Settings), which salesmen can't use. Give them their real workflow instead.
  // ---------------------------------------------------------------------------
  function navBtn(key, icon, label, badgeId) {
    return `
      <button type="button" data-mnav="${key}" class="${NAV_IDLE}">
        <span class="material-symbols-outlined text-[22px]">${icon}</span>
        ${badgeId ? `<span class="m-nav-badge" id="${badgeId}" data-n="0">0</span>` : ''}
        <span class="text-[10px] mt-0.5">${label}</span>
      </button>`;
  }

  function buildSalesmanNav() {
    const nav = $('mobileBottomNav');
    if (!nav) return;
    const hasStock = typeof currentStockAccess !== 'undefined' && currentStockAccess;

    nav.innerHTML = `
      ${navBtn('sell', 'point_of_sale', 'Sell')}
      ${navBtn('followup', 'local_fire_department', 'Follow-up', 'mNavFollowBadge')}
      <div class="px-2">
        <button type="button" data-mnav="new" class="w-12 h-12 -mt-5 rounded-full bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center justify-center cursor-pointer active:scale-95 border-2 border-white" title="New sale">
          <span class="material-symbols-outlined text-[24px]">add</span>
        </button>
      </div>
      ${navBtn('orders', 'receipt_long', 'Orders')}
      ${hasStock ? navBtn('stock', 'inventory_2', 'Stock') : navBtn('paid', 'task_alt', 'Paid')}
    `;

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mnav]');
      if (!btn) return;
      handleSalesNav(btn.getAttribute('data-mnav'));
    });

    salesNavBuilt = true;
    syncSalesNav();
    syncBadges();
  }

  function ensureStudio() {
    if (typeof currentMainView !== 'undefined' && currentMainView !== 'STUDIO') switchMainView('STUDIO');
  }

  function handleSalesNav(key) {
    switch (key) {
      case 'sell':
        ensureStudio();
        activateTab('NEW');
        scrollTopIfPhone();
        break;
      case 'new':
        ensureStudio();
        activateTab('NEW');
        scrollTopIfPhone();
        setTimeout(() => { const p = $('custPhone'); if (p) p.focus({ preventScroll: true }); }, 350);
        break;
      case 'followup':
        ensureStudio();
        switchActionQueue('FOLLOW_UP');
        scrollTopIfPhone();
        break;
      case 'paid':
        ensureStudio();
        switchActionQueue('CLOSED');
        scrollTopIfPhone();
        break;
      case 'orders': {
        if (typeof setMasterTab === 'function') {
          setMasterTab('dispatch');
        } else {
          ensureStudio();
        }
        salesNavKey = 'orders';
        syncSalesNav(true);
        scrollTopIfPhone();
        break;
      }
      case 'stock':
        if (typeof openStockCrmView === 'function') openStockCrmView();
        scrollTopIfPhone();
        break;
    }
  }

  // Derive the active dock item from the app's own state
  function syncSalesNav(keepKey) {
    if (!salesNavBuilt) return;
    if (!keepKey) {
      if (typeof currentMainView !== 'undefined' && currentMainView === 'MASTER') {
        if (typeof currentMasterTab !== 'undefined' && currentMasterTab === 'dispatch') salesNavKey = 'orders';
        else salesNavKey = 'stock';
      }
      else if (typeof currentActionQueue !== 'undefined' && currentActionQueue === 'FOLLOW_UP') salesNavKey = 'followup';
      else if (typeof currentActionQueue !== 'undefined' && currentActionQueue === 'CLOSED') salesNavKey = 'paid';
      else if (typeof currentActionQueue !== 'undefined' && currentActionQueue) salesNavKey = '';
      else salesNavKey = 'sell';
    }
    document.querySelectorAll('#mobileBottomNav button[data-mnav]').forEach((b) => {
      const k = b.getAttribute('data-mnav');
      if (k === 'new') return;
      b.className = k === salesNavKey ? NAV_ACTIVE : NAV_IDLE;
    });
  }

  function syncBadges() {
    const src = $('queueCountFollowUp');
    const badge = $('mNavFollowBadge');
    if (src && badge) {
      const n = parseInt(src.textContent, 10) || 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.setAttribute('data-n', String(n));
    }
  }

  // ---------------------------------------------------------------------------
  // Hook into seller.js globals (function declarations are global bindings, so
  // inline onclick handlers and internal calls both go through these wrappers).
  // ---------------------------------------------------------------------------
  function wrap(name, after) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      const out = orig.apply(this, arguments);
      try { after.apply(this, arguments); } catch (e) { /* never break the app */ }
      return out;
    };
  }

  wrap('activateTab', () => syncSalesNav());
  wrap('switchActionQueue', () => syncSalesNav());
  wrap('switchMainView', () => syncSalesNav());
  wrap('renderTabs', () => syncBadges());

  // Owner: switching master tabs from the dock should land at the top
  wrap('setMasterTab', () => { if (document.readyState === 'complete') scrollTopIfPhone(); });

  const origAuth = window.checkAuthAndLoadSeller;
  if (typeof origAuth === 'function') {
    window.checkAuthAndLoadSeller = async function () {
      const ok = await origAuth.apply(this, arguments);
      try {
        if (ok && typeof currentRole !== 'undefined' && currentRole === 'SALESMAN') buildSalesmanNav();
      } catch (e) { console.warn('mobile nav init failed', e); }
      return ok;
    };
  }
})();
