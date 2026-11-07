// PaySap Studio JavaScript - Multi-Tab Sales Cockpit & Master Dashboard Engine
let activeTab = 'NEW'; // 'NEW' or order ref (e.g. '101')
let activeRefNumber = null;
let activeOrder = null;
let cachedOrders = [];
let cachedProducts = [];
let currentFilter = 'ALL';
let pollingTimer = null;
let currentSeller = null;
let currentRole = 'OWNER'; // 'OWNER' or 'SALESMAN'
let currentSalesman = null;
let currentMainView = 'STUDIO'; // 'STUDIO' or 'MASTER'
let currentActionQueue = null; // null or 'FOLLOW_UP', 'ACTIVE', 'AWAITING', 'CLOSED'
let cachedSalesmenBreakdown = [];
let cachedAllSalesmen = [];
let cachedStoreFunnel = null;
let cachedAbandonedLeads = [];
let masterFilterStaff = 'ALL';
let currentStockAccess = false; // Owner or salesmen with stockAccess: true
let stockFilterCategory = 'ALL';
let stockSearchQuery = '';

// Auth token helper
function getAuthToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('token');
  if (urlToken) {
    localStorage.setItem('auth_token', urlToken);
    // Sanitize token from browser address bar to prevent token leakage in screenshots, history, or HTTP referrers
    urlParams.delete('token');
    const newSearch = urlParams.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    try {
      window.history.replaceState({}, document.title, newUrl);
    } catch (_) {}
    return urlToken;
  }
  return localStorage.getItem('auth_token') || '';
}

function getAuthHeaders(extraHeaders = {}) {
  const token = getAuthToken();
  const headers = { ...extraHeaders };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    headers['x-auth-token'] = token;
  }
  return headers;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Verify seller authentication
  const isAuth = await checkAuthAndLoadSeller();
  if (!isAuth) return;

  // 2. Initial fetch of seller-scoped orders & metrics
  await fetchOrdersAndMetrics();

  // 3. Load product catalog from database
  await fetchProductCatalog();

  // Attach live preview typing listeners in Quick Builder
  ['custName', 'custPhone', 'itemDesc', 'orderValue', 'itemSku'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', syncLivePitch);
  });

  // Handle form submission
  const form = document.getElementById('linkGeneratorForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleCreateOrder();
    });
  }

  // Filter tabs for bottom table
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => {
        t.className = 'filter-tab px-3 py-1 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold transition-colors cursor-pointer';
      });
      tab.className = 'filter-tab px-3 py-1 rounded-full bg-slate-900 text-white text-xs font-semibold shadow-xs cursor-pointer';
      currentFilter = tab.dataset.status;
      renderOrdersTable();
    });
  });

  // Initial pitch sync
  syncLivePitch();

  // Universal Modal Dismissal (Escape Key + Tap/Click Backdrop)
  const modalIds = [
    'modalQuickSale', 'addSalesmanModal', 'editSalesmanModal',
    'modalAddProduct', 'qrModal', 'modalTestEmail', 'modalOAuthConfig'
  ];

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      modalIds.forEach(id => {
        const m = document.getElementById(id);
        if (m && !m.classList.contains('hidden')) {
          m.classList.add('hidden');
        }
      });
    }
  });

  modalIds.forEach(id => {
    const m = document.getElementById(id);
    if (m) {
      m.addEventListener('click', (e) => {
        if (e.target === m) {
          m.classList.add('hidden');
        }
      });
    }
  });

  // Start continuous live polling radar (adapts to background/foreground)
  startLivePolling();
});

// Battery-aware and connectivity-resilient radar polling engine
let isPageHidden = false;

function startLivePolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  // When mobile tab is hidden or phone screen is locked, back off to 12s to preserve battery; when active, run 1.5s live radar
  const interval = isPageHidden ? 12000 : 1500;
  pollingTimer = setInterval(fetchOrdersAndMetrics, interval);
}

// Page Visibility API: instantaneously refresh metrics and restore high-frequency radar when user re-enters app
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    isPageHidden = true;
    startLivePolling();
  } else {
    isPageHidden = false;
    fetchOrdersAndMetrics();
    startLivePolling();
  }
});

// Network online/offline detection
window.addEventListener('offline', () => {
  showToast('📡 You are offline. Changes will sync when reconnected.');
});

window.addEventListener('online', () => {
  showToast('⚡ Reconnected! Live radar active.');
  fetchOrdersAndMetrics();
  startLivePolling();
});

// Check seller authentication and populate studio header
async function checkAuthAndLoadSeller() {
  try {
    const res = await fetch('/api/auth/me', {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (!data.authenticated || !data.seller) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('seller_profile');
      localStorage.removeItem('salesman_profile');
      window.location.href = '/auth';
      return false;
    }

    currentSeller = data.seller;
    currentRole = data.role || 'OWNER';
    currentSalesman = data.salesman || null;
    currentStockAccess = data.stockAccess !== undefined ? Boolean(data.stockAccess) : (currentRole === 'OWNER');

    localStorage.setItem('seller_profile', JSON.stringify(currentSeller));
    localStorage.setItem('auth_role', currentRole);
    if (currentSalesman) {
      localStorage.setItem('salesman_profile', JSON.stringify(currentSalesman));
    }

    // Update Header with Store Name & powered by PaySap
    const headerBrandName = document.getElementById('headerBrandName');
    const headerUpiId = document.getElementById('headerUpiId');
    const headerAvatar = document.getElementById('headerAvatar');
    const storeLogoIcon = document.getElementById('storeLogoIcon');
    const headerRoleBadge = document.getElementById('headerRoleBadge');
    const navBtnMaster = document.getElementById('navBtnMaster');
    const topStorePill = document.getElementById('topStorePill');

    const brandName = currentSeller.brandName || 'Store';
    if (headerBrandName) headerBrandName.textContent = brandName;
    if (topStorePill) topStorePill.textContent = brandName;
    if (headerUpiId) headerUpiId.textContent = currentSeller.upiId || 'direct@upi';

    const initials = brandName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || 'PS';
    if (currentSeller.storeLogo) {
      if (storeLogoIcon) {
        storeLogoIcon.innerHTML = `<img src="${escapeHtml(currentSeller.storeLogo)}" alt="Logo" class="w-full h-full object-cover rounded-2xl"/>`;
      }
      if (headerAvatar) {
        headerAvatar.innerHTML = `<img src="${escapeHtml(currentSeller.storeLogo)}" alt="Logo" class="w-full h-full object-cover rounded-full"/>`;
      }
    } else {
      if (headerAvatar) headerAvatar.textContent = initials;
      if (storeLogoIcon) storeLogoIcon.textContent = initials;
    }

    const headerMasterNav = document.getElementById('headerMasterNav');
    const mTabOverview = document.getElementById('mTabBtnOverview');
    const mTabDispatch = document.getElementById('mTabBtnDispatch');
    const mTabSettings = document.getElementById('mTabBtnSettings');
    const mTabInventory = document.getElementById('mTabBtnInventory');
    const mBtnQuickSale = document.getElementById('mBtnQuickSale');

    // Role-specific Header & View initialization
    const kpiRevLabel = document.getElementById('kpiRevenueLabel');
    const kpiCreatedLabel = document.getElementById('kpiCreatedLabel');

    // Synchronize body styling & permission classes for bulletproof CSS protection
    if (currentRole === 'SALESMAN') {
      document.body.classList.add('role-salesman');
      if (!currentStockAccess) {
        document.body.classList.add('no-stock');
      } else {
        document.body.classList.remove('no-stock');
      }
    } else {
      document.body.classList.remove('role-salesman', 'no-stock');
    }

    if (currentRole === 'SALESMAN' && currentSalesman) {
      if (kpiRevLabel) kpiRevLabel.textContent = 'My Sales:';
      if (kpiCreatedLabel) kpiCreatedLabel.textContent = 'My Links:';

      if (headerRoleBadge) {
        const stockPill = currentStockAccess ? ' • 📦 Stock Access' : '';
        headerRoleBadge.innerHTML = `<span class="text-emerald-700 font-extrabold flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ${escapeHtml(currentSalesman.name)}${stockPill}</span>`;
      }
      if (headerMasterNav) {
        headerMasterNav.classList.remove('hidden');
      }
      syncNavTabsVisibility();
      switchMainView('STUDIO');
    } else {
      if (kpiRevLabel) kpiRevLabel.textContent = 'Gross Revenue:';
      if (kpiCreatedLabel) kpiCreatedLabel.textContent = 'Links:';

      if (headerRoleBadge) {
        headerRoleBadge.innerHTML = `<span class="text-indigo-700 font-extrabold flex items-center gap-1">👑 Store Owner (Master)</span>`;
      }
      if (headerMasterNav) {
        headerMasterNav.classList.remove('hidden');
      }
      syncNavTabsVisibility();
      switchMainView('MASTER');
      const urlParams = new URLSearchParams(window.location.search);
      const tabParam = urlParams.get('tab');
      if (tabParam === 'dispatch') {
        setMasterTab('dispatch');
      } else if (tabParam === 'settings') {
        setMasterTab('settings');
      } else if (tabParam === 'inventory') {
        setMasterTab('inventory');
      } else {
        setMasterTab('overview');
      }
    }

    return true;
  } catch (err) {
    console.error('Auth verification error:', err);
    window.location.href = '/auth';
    return false;
  }
}

// Fetch Product Catalog from Database and populate dropdown & quick pills
async function fetchProductCatalog(showToastOnSuccess = false) {
  try {
    const res = await fetch('/api/products', {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    cachedProducts = data.products || [];

    const select = document.getElementById('catalogSelect');
    const datalist = document.getElementById('skuDatalist');
    const quickChips = document.getElementById('catalogQuickChips');

    // Populate Dropdown with stock levels
    if (select) {
      select.innerHTML = `
        <option value="">-- Choose from Catalog or Enter Custom SKU below --</option>
        ${cachedProducts.map(p => {
          const isOut = typeof p.stock === 'number' && p.stock <= 0;
          const stockLabel = typeof p.stock === 'number' 
            ? (p.stock > 0 ? `(${p.stock} in stock)` : `❌ [OUT OF STOCK]`) 
            : '';
          return `
            <option value="${p.sku}" data-stock="${p.stock || 0}">
              ${isOut ? '❌' : '⚡'} [${p.sku}] ${escapeHtml(p.name)} • ₹${p.price.toLocaleString('en-IN')} ${stockLabel}
            </option>
          `;
        }).join('')}
      `;
    }

    // Populate Datalist for autocomplete
    if (datalist) {
      datalist.innerHTML = cachedProducts.map(p => `
        <option value="${p.sku}">${escapeHtml(p.name)} (₹${p.price}) - ${typeof p.stock === 'number' ? (p.stock > 0 ? p.stock + ' in stock' : 'OUT OF STOCK') : ''}</option>
      `).join('');
    }

    // Populate Quick SKU Chips
    if (quickChips) {
      quickChips.innerHTML = cachedProducts.slice(0, 5).map(p => {
        const isOut = typeof p.stock === 'number' && p.stock <= 0;
        const chipClasses = isOut
          ? 'bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-800'
          : 'bg-white hover:bg-indigo-50 border-slate-200 hover:border-indigo-300 text-slate-700';
        const stockBadge = typeof p.stock === 'number'
          ? (p.stock > 0 ? `<span class="text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1 py-0.2 rounded font-mono">${p.stock} left</span>` : `<span class="text-[9px] font-bold text-rose-700 bg-rose-100 px-1 py-0.2 rounded font-mono">0 left</span>`)
          : '';

        return `
          <button 
            type="button" 
            onclick="handleCatalogSelect('${p.sku}')" 
            class="px-2.5 py-1 ${chipClasses} border text-xs font-semibold rounded-lg shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer">
            <span class="font-mono text-indigo-600 font-bold text-[10px]">#${p.sku}</span>
            <span class="truncate max-w-[130px]">${escapeHtml(p.name)}</span>
            <span class="font-bold">₹${p.price}</span>
            ${stockBadge}
          </button>
        `;
      }).join('');
    }

    // Refresh Stock CRM table if rendered
    renderStockCrmTable();

    if (showToastOnSuccess) {
      showToast('📦 Product Catalog & Stock registry updated!');
    }

  } catch (err) {
    console.error('Failed to load product catalog:', err);
  }
}

// Enforce Stock Control: Blocks salesmen from creating links if stock is 0
function checkAndEnforceProductStock(product) {
  const stockAlertBanner = document.getElementById('stockAlertBanner');
  const stockAlertText = document.getElementById('stockAlertText');
  const btnSubmitGenerate = document.getElementById('btnSubmitGenerate');
  const btnSubmitGenerateText = document.getElementById('btnSubmitGenerateText');
  const btnQuickRestockAction = document.getElementById('btnQuickRestockAction');
  const stockStatusIndicator = document.getElementById('stockStatusIndicator');
  const stockStatusText = document.getElementById('stockStatusText');

  if (!product) {
    if (stockAlertBanner) stockAlertBanner.classList.add('hidden');
    if (btnSubmitGenerate) {
      btnSubmitGenerate.disabled = false;
      btnSubmitGenerate.className = 'mt-1 w-full h-12 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-emerald-600/25 flex items-center justify-center gap-2 transition-all cursor-pointer';
    }
    if (btnSubmitGenerateText) btnSubmitGenerateText.textContent = '📲 Send Order Link via WhatsApp';
    return true;
  }

  const isOutOfStock = typeof product.stock === 'number' && product.stock <= 0;

  if (isOutOfStock) {
    if (stockAlertBanner) stockAlertBanner.classList.remove('hidden');
    if (stockAlertText) {
      stockAlertText.textContent = `❌ Out of Stock: "${product.name}" has 0 units remaining. Cannot create order link.`;
    }
    if (btnQuickRestockAction) {
      btnQuickRestockAction.classList.toggle('hidden', !currentStockAccess);
    }
    if (btnSubmitGenerate) {
      btnSubmitGenerate.disabled = true;
      btnSubmitGenerate.className = 'mt-1 w-full h-12 bg-slate-300 text-slate-500 font-bold text-xs sm:text-sm rounded-xl flex items-center justify-center gap-2 cursor-not-allowed opacity-70';
    }
    if (btnSubmitGenerateText) {
      btnSubmitGenerateText.textContent = '❌ Cannot Send - Item Out of Stock';
    }
    if (stockStatusIndicator) {
      stockStatusIndicator.className = 'flex items-center gap-1 font-medium text-rose-600';
    }
    if (stockStatusText) {
      stockStatusText.textContent = '❌ Out of Stock (0)';
    }
    showToast(`⚠️ [${product.sku}] is currently Out of Stock (0 units)!`);
    return false;
  } else {
    if (stockAlertBanner) stockAlertBanner.classList.add('hidden');
    if (btnSubmitGenerate) {
      btnSubmitGenerate.disabled = false;
      btnSubmitGenerate.className = 'mt-1 w-full h-12 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-emerald-600/25 flex items-center justify-center gap-2 transition-all cursor-pointer';
    }
    if (btnSubmitGenerateText) {
      btnSubmitGenerateText.textContent = '📲 Send Order Link via WhatsApp';
    }
    if (stockStatusIndicator) {
      stockStatusIndicator.className = 'flex items-center gap-1 font-medium text-emerald-600';
    }
    if (stockStatusText) {
      const stockQty = typeof product.stock === 'number' ? ` (${product.stock} in stock)` : '';
      stockStatusText.textContent = `In Stock${stockQty}`;
    }
    return true;
  }
}

// Quick Restock shortcut triggered from the builder banner
function openRestockFromBuilder() {
  const itemSku = document.getElementById('itemSku')?.value?.trim();
  const product = cachedProducts.find(p => p.sku.toUpperCase() === (itemSku || '').toUpperCase());
  if (product) {
    handleAdjustStock(product.id, 5);
  } else {
    openStockCrmView();
  }
}

// Auto-fill product details when an item is selected from dropdown or chips
function handleCatalogSelect(sku) {
  if (!sku) {
    checkAndEnforceProductStock(null);
    return;
  }
  const product = cachedProducts.find(p => p.sku.toUpperCase() === sku.toUpperCase() || p.id === sku);
  if (!product) return;

  const itemSku = document.getElementById('itemSku');
  const itemDesc = document.getElementById('itemDesc');
  const orderValue = document.getElementById('orderValue');
  const internalNotes = document.getElementById('internalNotes');
  const catalogSelect = document.getElementById('catalogSelect');
  const skuStatusNotice = document.getElementById('skuStatusNotice');

  if (itemSku) itemSku.value = product.sku;
  if (itemDesc) itemDesc.value = product.name;
  if (orderValue) orderValue.value = product.price;
  if (internalNotes && product.notes && !internalNotes.value) {
    internalNotes.value = product.notes;
  }
  if (catalogSelect) catalogSelect.value = product.sku;

  const inStock = typeof product.stock === 'number' ? product.stock > 0 : true;

  if (skuStatusNotice) {
    if (inStock) {
      skuStatusNotice.innerHTML = `<span class="text-emerald-600 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${product.stock} in stock • Auto-filled</span>`;
    } else {
      skuStatusNotice.innerHTML = `<span class="text-rose-600 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> OUT OF STOCK (0)</span>`;
    }
  }

  // Enforce Stock check
  checkAndEnforceProductStock(product);

  syncLivePitch();
  if (inStock) {
    showToast(`⚡ Selected [${product.sku}] ${product.name} (${product.stock} in stock)`);
  }
}

// Instant lookup as seller types in the SKU input box
function lookupSku(val) {
  const clean = (val || '').trim().toUpperCase();
  const skuStatusNotice = document.getElementById('skuStatusNotice');
  if (!clean) {
    if (skuStatusNotice) skuStatusNotice.textContent = 'Printed on bill';
    checkAndEnforceProductStock(null);
    return;
  }

  const product = cachedProducts.find(p => 
    p.sku.toUpperCase() === clean || 
    (p.id && p.id.toUpperCase() === clean)
  );

  if (product) {
    const itemDesc = document.getElementById('itemDesc');
    const orderValue = document.getElementById('orderValue');
    const internalNotes = document.getElementById('internalNotes');
    const catalogSelect = document.getElementById('catalogSelect');

    if (itemDesc) itemDesc.value = product.name;
    if (orderValue) orderValue.value = product.price;
    if (internalNotes && product.notes && !internalNotes.value) {
      internalNotes.value = product.notes;
    }
    if (catalogSelect) catalogSelect.value = product.sku;

    const inStock = typeof product.stock === 'number' ? product.stock > 0 : true;

    if (skuStatusNotice) {
      if (inStock) {
        skuStatusNotice.innerHTML = `<span class="text-emerald-600 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> SKU Matched: ₹${product.price} (${product.stock} in stock)</span>`;
      } else {
        skuStatusNotice.innerHTML = `<span class="text-rose-600 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> OUT OF STOCK (0)</span>`;
      }
    }

    checkAndEnforceProductStock(product);
    syncLivePitch();
  }
}

// Seller Logout
async function handleLogout() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: getAuthHeaders()
    });
  } catch (e) {}

  localStorage.removeItem('auth_token');
  localStorage.removeItem('seller_profile');
  showToast('Logged out successfully');
  setTimeout(() => {
    window.location.href = '/auth';
  }, 400);
}

// Helper: Relative time formatting
function timeAgo(isoString) {
  if (!isoString) return 'recently';
  const diffSecs = Math.max(1, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Categorize cached orders into the 4 Action Queues (Mutually Exclusive for 100% Accuracy)
function getQueueOrders(queueType) {
  if (!cachedOrders) return [];
  if (queueType === 'CLOSED') {
    // Confirmed paid sales
    return cachedOrders.filter(o => o.status === 'PAID');
  } else if (queueType === 'ACTIVE') {
    // Orders currently active (customer launched UPI payment app and is completing payment)
    return cachedOrders.filter(o => 
      o.status !== 'PAID' && 
      o.steps && 
      o.steps.redirectedToPayment && 
      o.steps.redirectedToPayment.done
    );
  } else if (queueType === 'FOLLOW_UP') {
    // Orders where customer engaged (opened link or entered shipping address), but hasn't launched payment app yet
    return cachedOrders.filter(o => 
      o.status !== 'PAID' && 
      (!o.steps || !o.steps.redirectedToPayment || !o.steps.redirectedToPayment.done) &&
      (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done) || (o.steps && o.steps.opened && o.steps.opened.done))
    );
  } else if (queueType === 'AWAITING') {
    // Link shared, customer hasn't opened yet
    return cachedOrders.filter(o => 
      o.status !== 'PAID' && 
      (!o.steps || !o.steps.redirectedToPayment || !o.steps.redirectedToPayment.done) &&
      !o.address &&
      (!o.steps || !o.steps.addressEntered || !o.steps.addressEntered.done) &&
      (!o.steps || !o.steps.opened || !o.steps.opened.done)
    );
  }
  return [];
}

// Update active states of the queue navigation buttons
function updateQueueButtonStyles() {
  const tabBtnNewSale = document.getElementById('tabBtnNewSale');
  const btnFollowUp = document.getElementById('btnQueueFollowUp');
  const btnActive = document.getElementById('btnQueueActive');
  const btnAwaiting = document.getElementById('btnQueueAwaiting');
  const btnClosed = document.getElementById('btnQueueClosed');

  const btnActiveClasses = 'px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer bg-slate-900 text-white shadow-xs shrink-0 ring-2 ring-indigo-500/30';
  const btnInactiveClasses = 'px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 shrink-0';

  if (tabBtnNewSale) {
    tabBtnNewSale.className = activeTab === 'NEW' 
      ? 'px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer bg-indigo-600 text-white shadow-xs shrink-0'
      : 'px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 shrink-0';
  }

  if (btnFollowUp) btnFollowUp.className = currentActionQueue === 'FOLLOW_UP' ? btnActiveClasses : btnInactiveClasses;
  if (btnActive) btnActive.className = currentActionQueue === 'ACTIVE' ? btnActiveClasses : btnInactiveClasses;
  if (btnAwaiting) btnAwaiting.className = currentActionQueue === 'AWAITING' ? btnActiveClasses : btnInactiveClasses;
  if (btnClosed) btnClosed.className = currentActionQueue === 'CLOSED' ? btnActiveClasses : btnInactiveClasses;
}

// Switch to Action Queue view
function switchActionQueue(queueType) {
  currentActionQueue = queueType;
  activeTab = 'QUEUE';

  const viewNewSale = document.getElementById('viewNewSale');
  const viewSaleDetail = document.getElementById('viewSaleDetail');
  const viewActionQueue = document.getElementById('viewActionQueue');

  if (viewNewSale) viewNewSale.classList.add('hidden');
  if (viewSaleDetail) viewSaleDetail.classList.add('hidden');
  if (viewActionQueue) viewActionQueue.classList.remove('hidden');

  updateQueueButtonStyles();
  renderActionQueueContent();
}

// Render cards for the currently selected Action Queue
function renderActionQueueContent() {
  const container = document.getElementById('actionQueueCardsContainer');
  const titleEl = document.getElementById('actionQueueTitle');
  const descEl = document.getElementById('actionQueueDesc');
  if (!container || !currentActionQueue) return;

  const queueOrders = getQueueOrders(currentActionQueue);

  let title = 'Action Queue';
  let desc = '';
  if (currentActionQueue === 'FOLLOW_UP') {
    title = '🔥 Needs Follow-Up';
    desc = 'Customers who opened the link or entered their address, but haven\'t paid yet. Tap WhatsApp nudge to recover.';
  } else if (currentActionQueue === 'ACTIVE') {
    title = '👀 Active Buyers';
    desc = 'Customers currently reviewing order specifications or launched in UPI apps.';
  } else if (currentActionQueue === 'AWAITING') {
    title = '⏳ Awaiting Customer';
    desc = 'Order links shared with customers who have not opened them yet.';
  } else if (currentActionQueue === 'CLOSED') {
    title = '✅ Closed & Paid';
    desc = 'Successfully settled orders with verified bank payments ready for fulfillment.';
  }

  if (titleEl) titleEl.textContent = `${title} (${queueOrders.length})`;
  if (descEl) descEl.textContent = desc;

  if (queueOrders.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 bg-slate-50/70 border border-slate-200/80 rounded-2xl p-6">
        <span class="material-symbols-outlined text-[32px] text-slate-300">task_alt</span>
        <p class="font-bold text-xs text-slate-600 mt-1">Queue is clear!</p>
        <p class="text-[11px] text-slate-400">No orders currently waiting in this queue.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = queueOrders.map(order => {
    const payable = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);
    const origin = window.location.origin;
    const payUrl = `${origin}/pay?ref=${order.ref}`;
    const cleanPhone = (order.customerPhone || '').replace(/\D/g, '').slice(-10);

    let timingText = '';
    const steps = order.steps || {};
    if (steps.addressEntered && steps.addressEntered.done && steps.addressEntered.time) {
      timingText = `Address saved ${timeAgo(steps.addressEntered.time)}`;
    } else if (steps.opened && steps.opened.done && steps.opened.time) {
      timingText = `Opened ${timeAgo(steps.opened.time)}`;
    } else {
      timingText = `Shared ${timeAgo(order.createdAt)}`;
    }

    const cleanName = (order.customerName || '').trim();
    const displayName = cleanName || `#REF-${order.ref}`;
    const greeting = cleanName ? `Hi ${cleanName.split(' ')[0]}!` : 'Hello!';
    const brand = (currentSeller && currentSeller.brandName) || 'Store';
    const waFollowUp = `${greeting} ✨ Following up on your order for *${order.itemDescription}* (₹${payable}) with ${brand}.\n\nTap here to confirm your delivery address & pay securely via UPI:\n👉 ${payUrl}\n\nPlease let us know if you have any questions!`;
    const waLink = cleanPhone ? `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(waFollowUp)}` : `https://wa.me/?text=${encodeURIComponent(waFollowUp)}`;

    return `
      <div class="bg-white border border-slate-200/90 hover:border-indigo-300 rounded-2xl p-4 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between gap-3">
        <div>
          <div class="flex items-center justify-between text-xs pb-2 border-b border-slate-100">
            <span class="font-mono font-bold text-indigo-600">#${order.ref}</span>
            <span class="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">${timingText}</span>
          </div>

          <div class="mt-2.5">
            <h4 class="font-bold text-slate-900 text-sm truncate">${escapeHtml(displayName)}</h4>
            <p class="text-xs text-slate-400 font-mono">${order.customerPhone ? '+91 ' + escapeHtml(order.customerPhone) : 'No phone'}</p>
          </div>

          <div class="mt-2 text-xs text-slate-600 truncate">
            ${order.sku ? `<span class="font-mono text-indigo-600 font-bold text-[10px]">#${escapeHtml(order.sku)}</span> ` : ''}
            <span>${escapeHtml(order.itemDescription)}</span>
          </div>
        </div>

        <div class="pt-2.5 border-t border-slate-100 flex flex-col gap-2">
          <div class="flex items-baseline justify-between">
            <span class="text-[11px] text-slate-400">Payable:</span>
            <span class="text-base font-extrabold text-slate-900 font-mono">₹${payable}</span>
          </div>

          <div class="grid grid-cols-2 gap-2 mt-1">
            <a href="${waLink}" target="_blank" class="h-9 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors no-underline shadow-2xs">
              <span class="material-symbols-outlined text-[16px]">chat</span>
              <span>WhatsApp</span>
            </a>
            ${cleanPhone ? `
              <a href="tel:+91${cleanPhone}" class="h-9 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors no-underline shadow-2xs">
                <span class="material-symbols-outlined text-[15px]">call</span>
                <span>Call Client</span>
              </a>
            ` : `
              <button type="button" onclick="activateTab('${order.ref}')" class="h-9 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer">
                <span>View Cockpit</span>
                <span class="material-symbols-outlined text-[15px]">arrow_forward</span>
              </button>
            `}
          </div>

          <div class="grid grid-cols-2 gap-2 mt-0.5">
            <button type="button" onclick="shareOrderLinkMobile('${order.ref}', '${payUrl}', '${escapeHtml(order.itemDescription).replace(/'/g, "\\'")}', '${payable}')" class="h-8 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer">
              <span class="material-symbols-outlined text-[14px]">share</span>
              <span>Share Link</span>
            </button>
            <button type="button" onclick="activateTab('${order.ref}')" class="h-8 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer">
              <span>Radar Cockpit</span>
              <span class="material-symbols-outlined text-[14px]">arrow_forward</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Rapid Showroom Loop: clear form and stay in generator mode
function createNextSale() {
  clearForm();
  activateTab('NEW');
  showToast('⚡ Form ready for next customer!');
}

// Quick switch to Studio Sales Cockpit from anywhere in the application
function switchToStudioCockpit() {
  switchMainView('STUDIO');
  if (!activeTab || activeTab === 'NEW') {
    if (cachedOrders && cachedOrders.length > 0) {
      activateTab(cachedOrders[0].ref);
    } else {
      activateTab('NEW');
    }
  } else {
    activateTab(activeTab);
  }
}

// Switch active tab between '+ New Sale' and individual sale detail
function activateTab(tabId) {
  activeTab = String(tabId);
  currentActionQueue = null;

  // Make sure Studio view is active so Cockpit is immediately visible!
  if (currentMainView !== 'STUDIO') {
    switchMainView('STUDIO');
  }
  
  const viewNewSale = document.getElementById('viewNewSale');
  const viewSaleDetail = document.getElementById('viewSaleDetail');
  const viewActionQueue = document.getElementById('viewActionQueue');

  if (viewActionQueue) viewActionQueue.classList.add('hidden');

  if (activeTab === 'NEW') {
    if (viewNewSale) viewNewSale.classList.remove('hidden');
    if (viewSaleDetail) viewSaleDetail.classList.add('hidden');
    activeOrder = null;
  } else {
    if (viewNewSale) viewNewSale.classList.add('hidden');
    if (viewSaleDetail) viewSaleDetail.classList.remove('hidden');
    
    // Find the order for this tab robustly (by ref, token, id, or storeRef - case-insensitive)
    const target = activeTab.trim().toLowerCase();
    const order = cachedOrders.find(o => 
      String(o.ref).toLowerCase() === target || 
      (o.token && o.token.toLowerCase() === target) || 
      String(o.id).toLowerCase() === target ||
      (o.storeRef && String(o.storeRef).toLowerCase() === target)
    );
    if (order) {
      activeOrder = order;
      renderCockpit(order);
    }
  }

  updateQueueButtonStyles();
}

// Update Action Queue badge counts and active tab styles
function renderTabs() {
  updateQueueButtonStyles();

  const followUpCount = getQueueOrders('FOLLOW_UP').length;
  const activeCount = getQueueOrders('ACTIVE').length;
  const awaitingCount = getQueueOrders('AWAITING').length;
  const closedCount = getQueueOrders('CLOSED').length;

  const qFollowUp = document.getElementById('queueCountFollowUp');
  const qActive = document.getElementById('queueCountActive');
  const qAwaiting = document.getElementById('queueCountAwaiting');
  const qClosed = document.getElementById('queueCountClosed');

  if (qFollowUp) qFollowUp.textContent = followUpCount;
  if (qActive) qActive.textContent = activeCount;
  if (qAwaiting) qAwaiting.textContent = awaitingCount;
  if (qClosed) qClosed.textContent = closedCount;

  if (currentActionQueue) {
    renderActionQueueContent();
  }
}

// Render the Live Sale Cockpit with the 5 Customer Steps & Master Spreadsheet Sync
function renderCockpit(order) {
  if (!order) return;

  const origin = window.location.origin;
  const payUrl = `${origin}/pay?ref=${order.ref}`;
  const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);
  const baseAmt = Number(order.amount).toFixed(2);
  const hasOffset = Number(payableAmt) !== Number(baseAmt);

  // Top Banner
  const cockpitRefBadge = document.getElementById('cockpitRefBadge');
  const cockpitCustomerName = document.getElementById('cockpitCustomerName');
  const cockpitCustomerPhone = document.getElementById('cockpitCustomerPhone');
  const cockpitItemDesc = document.getElementById('cockpitItemDesc');
  const cockpitPayableAmount = document.getElementById('cockpitPayableAmount');
  const cockpitBaseAmount = document.getElementById('cockpitBaseAmount');
  const cockpitPaiseBadge = document.getElementById('cockpitPaiseBadge');
  const btnCockpitTestView = document.getElementById('btnCockpitTestView');

  if (cockpitRefBadge) cockpitRefBadge.textContent = `REF #${order.ref}`;
  const cleanCockpitName = (order.customerName || '').trim();
  if (cockpitCustomerName) cockpitCustomerName.textContent = cleanCockpitName || `Order #REF-${order.ref}`;
  if (cockpitCustomerPhone) cockpitCustomerPhone.textContent = order.customerPhone ? `+91 ${order.customerPhone}` : 'No Phone Provided';
  if (cockpitItemDesc) {
    const skuText = order.sku ? `[${order.sku}] ` : '';
    cockpitItemDesc.textContent = `${skuText}${order.itemDescription}`;
  }
  if (cockpitPayableAmount) cockpitPayableAmount.textContent = `₹${payableAmt}`;
  if (cockpitBaseAmount) cockpitBaseAmount.textContent = `(Base ₹${baseAmt})`;
  if (cockpitPaiseBadge) {
    cockpitPaiseBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Active Link`;
  }

  if (btnCockpitTestView) {
    btnCockpitTestView.href = payUrl;
  }

  // Journey Steps Normalization
  const steps = order.steps || {};
  const isOpened = Boolean(steps.opened && steps.opened.done);
  const isAddressAdded = Boolean(order.address || (steps.addressEntered && steps.addressEntered.done));
  const isRedirected = Boolean(steps.redirectedToPayment && steps.redirectedToPayment.done);
  const isPaid = order.status === 'PAID' || Boolean(steps.paymentConfirmed && steps.paymentConfirmed.done);

  // Status Pill Header
  const cockpitStatusPill = document.getElementById('cockpitStatusPill');
  if (cockpitStatusPill) {
    if (isPaid) {
      cockpitStatusPill.className = 'px-3 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-800 border border-emerald-300';
      cockpitStatusPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span> PAYMENT CONFIRMED & RESERVED`;
    } else if (isRedirected) {
      cockpitStatusPill.className = 'px-3 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1.5 bg-purple-100 text-purple-800 border border-purple-300';
      cockpitStatusPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></span> IN PAYMENT APP (${steps.redirectedToPayment.app || 'UPI'})`;
    } else if (isAddressAdded) {
      cockpitStatusPill.className = 'px-3 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1.5 bg-indigo-100 text-indigo-800 border border-indigo-300';
      cockpitStatusPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-indigo-600"></span> ADDRESS ENTERED • READY FOR PAYMENT`;
    } else if (isOpened) {
      cockpitStatusPill.className = 'px-3 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1.5 bg-blue-100 text-blue-800 border border-blue-300';
      cockpitStatusPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500"></span> LINK VIEWED • ENTERING ADDRESS`;
    } else {
      cockpitStatusPill.className = 'px-3 py-1 rounded-full text-xs font-bold inline-flex items-center gap-1.5 bg-amber-100 text-amber-800 border border-amber-300 animate-pulse';
      cockpitStatusPill.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> WAITING FOR CUSTOMER`;
    }
  }

  // Update Top Command Bar Confirm Payment Button
  const btnCockpitMarkPaid = document.getElementById('btnCockpitMarkPaid');
  if (btnCockpitMarkPaid) {
    if (isPaid) {
      btnCockpitMarkPaid.classList.remove('hidden');
      btnCockpitMarkPaid.className = 'px-3.5 py-2 bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-default select-none';
      btnCockpitMarkPaid.innerHTML = `<span class="material-symbols-outlined text-[16px] text-emerald-400">task_alt</span><span>✓ Settled</span>`;
      btnCockpitMarkPaid.disabled = true;
    } else if (currentRole === 'OWNER') {
      btnCockpitMarkPaid.classList.remove('hidden');
      btnCockpitMarkPaid.className = 'px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-md shadow-emerald-600/20';
      btnCockpitMarkPaid.innerHTML = `<span class="material-symbols-outlined text-[16px]">check_circle</span><span>Confirm Payment</span>`;
      btnCockpitMarkPaid.disabled = false;
    } else {
      btnCockpitMarkPaid.classList.add('hidden');
    }
  }

  // --- Step 1: Link Sent ---
  const step1Time = document.getElementById('step1Time');
  if (step1Time) {
    const timeStr = formatStepTime(steps.shared && steps.shared.time ? steps.shared.time : order.createdAt);
    step1Time.textContent = `Sent ${timeStr}`;
  }

  // --- Step 2: Link Viewed ---
  const stepCard2 = document.getElementById('stepCard2');
  const step2Icon = document.getElementById('step2Icon');
  const step2Tag = document.getElementById('step2Tag');
  const step2Title = document.getElementById('step2Title');
  const step2Desc = document.getElementById('step2Desc');
  const step2Time = document.getElementById('step2Time');

  if (stepCard2 && step2Title && step2Desc && step2Time) {
    if (!isOpened && !isPaid && !isRedirected && !isAddressAdded) {
      stepCard2.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-amber-50/70 border-amber-300 ring-2 ring-amber-200/80 shadow-sm';
      if (step2Icon) {
        step2Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-amber-100 text-amber-700';
        step2Icon.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">hourglass_top</span>`;
      }
      if (step2Tag) {
        step2Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-md flex items-center gap-1';
        step2Tag.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span> WAITING`;
      }
      step2Title.textContent = 'Waiting for Customer';
      step2Desc.textContent = 'Link delivered on WhatsApp. Waiting for customer to open...';
      step2Time.className = 'pt-2 border-t border-amber-200/70 text-[10px] text-amber-800 font-bold';
      step2Time.textContent = 'Awaiting customer tap';
    } else {
      stepCard2.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-emerald-50/60 border-emerald-200';
      if (step2Icon) {
        step2Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-emerald-100 text-emerald-700';
        step2Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">visibility</span>`;
      }
      if (step2Tag) {
        step2Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md';
        step2Tag.textContent = 'STEP 2 • DONE';
      }
      step2Title.textContent = 'Link Viewed';
      step2Desc.textContent = 'Customer opened checkout reservation on mobile.';
      step2Time.className = 'pt-2 border-t border-emerald-100 text-[10px] text-emerald-700 font-semibold';
      step2Time.textContent = `Opened ${formatStepTime((steps.opened && steps.opened.time) || order.createdAt)}`;
    }
  }

  // --- Step 3: Address Added ---
  const stepCard3 = document.getElementById('stepCard3');
  const step3Icon = document.getElementById('step3Icon');
  const step3Tag = document.getElementById('step3Tag');
  const step3Title = document.getElementById('step3Title');
  const step3Desc = document.getElementById('step3Desc');
  const step3Time = document.getElementById('step3Time');

  if (stepCard3 && step3Title && step3Desc && step3Time) {
    if (isAddressAdded) {
      stepCard3.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-emerald-50/60 border-emerald-200';
      if (step3Icon) {
        step3Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-emerald-100 text-emerald-700';
        step3Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">local_shipping</span>`;
      }
      if (step3Tag) {
        step3Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md';
        step3Tag.textContent = 'STEP 3 • DONE';
      }
      step3Title.textContent = 'Address Added';
      const city = order.address ? (order.address.city || '') : '';
      step3Desc.textContent = city ? `Delivery destination: ${escapeHtml(city)}` : 'Customer entered shipping details.';
      step3Time.className = 'pt-2 border-t border-emerald-100 text-[10px] text-emerald-700 font-semibold';
      step3Time.textContent = `Saved ${formatStepTime(steps.addressEntered?.time || order.createdAt)}`;
    } else if (isPaid) {
      // Order is already PAID, but direct sale / no doorstep shipping was entered
      stepCard3.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-emerald-50/60 border-emerald-200';
      if (step3Icon) {
        step3Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-emerald-100 text-emerald-700';
        step3Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">storefront</span>`;
      }
      if (step3Tag) {
        step3Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md';
        step3Tag.textContent = 'STEP 3 • DONE';
      }
      step3Title.textContent = 'Direct Sale / In-Store';
      step3Desc.textContent = 'Direct purchase (no physical delivery address required).';
      step3Time.className = 'pt-2 border-t border-emerald-100 text-[10px] text-emerald-700 font-semibold';
      step3Time.textContent = `Completed ${formatStepTime(order.paidAt || order.createdAt)}`;
    } else if (isOpened) {
      stepCard3.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-blue-50/60 border-blue-200 shadow-2xs';
      if (step3Icon) {
        step3Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-blue-100 text-blue-700';
        step3Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">edit_location</span>`;
      }
      if (step3Tag) {
        step3Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-blue-700 bg-blue-100 px-2 py-0.5 rounded-md';
        step3Tag.textContent = 'IN PROGRESS';
      }
      step3Title.textContent = 'Entering Address';
      step3Desc.textContent = 'Customer is currently filling out doorstep shipping details.';
      step3Time.className = 'pt-2 border-t border-blue-100 text-[10px] text-blue-700 font-semibold';
      step3Time.textContent = 'Active on checkout';
    } else {
      stepCard3.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-slate-50 border-slate-200 opacity-60';
      if (step3Icon) {
        step3Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-slate-200 text-slate-600';
        step3Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">local_shipping</span>`;
      }
      if (step3Tag) {
        step3Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-slate-500 bg-slate-200 px-2 py-0.5 rounded-md';
        step3Tag.textContent = 'STEP 3';
      }
      step3Title.textContent = 'Address Added';
      step3Desc.textContent = 'Doorstep delivery address.';
      step3Time.className = 'pt-2 border-t border-slate-200/60 text-[10px] text-slate-400 font-medium';
      step3Time.textContent = 'Pending';
    }
  }

  // --- Step 4: Payment Started ---
  const stepCard4 = document.getElementById('stepCard4');
  const step4Icon = document.getElementById('step4Icon');
  const step4Tag = document.getElementById('step4Tag');
  const step4Title = document.getElementById('step4Title');
  const step4Desc = document.getElementById('step4Desc');
  const step4Time = document.getElementById('step4Time');

  if (stepCard4 && step4Title && step4Desc && step4Time) {
    if (isPaid || isRedirected) {
      stepCard4.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-emerald-50/60 border-emerald-200';
      if (step4Icon) {
        step4Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-emerald-100 text-emerald-700';
        step4Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">account_balance_wallet</span>`;
      }
      if (step4Tag) {
        step4Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md';
        step4Tag.textContent = 'STEP 4 • DONE';
      }
      step4Title.textContent = 'Payment Started';
      step4Desc.textContent = `Customer launched ${steps.redirectedToPayment?.app || 'UPI App'}.`;
      step4Time.className = 'pt-2 border-t border-emerald-100 text-[10px] text-emerald-700 font-semibold';
      step4Time.textContent = `Launched ${formatStepTime(steps.redirectedToPayment?.time || order.paidAt || order.createdAt)}`;
    } else if (isAddressAdded) {
      stepCard4.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-amber-50/70 border-amber-300 ring-2 ring-amber-200/80 shadow-sm';
      if (step4Icon) {
        step4Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-amber-100 text-amber-700';
        step4Icon.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">sync</span>`;
      }
      if (step4Tag) {
        step4Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-md flex items-center gap-1';
        step4Tag.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span> READY`;
      }
      step4Title.textContent = 'Ready for Payment';
      step4Desc.textContent = `Awaiting customer to tap UPI button for ₹${payableAmt}.`;
      step4Time.className = 'pt-2 border-t border-amber-200/70 text-[10px] text-amber-800 font-bold';
      step4Time.textContent = 'High-intent lead';
    } else {
      stepCard4.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-slate-50 border-slate-200 opacity-60';
      if (step4Icon) {
        step4Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-slate-200 text-slate-600';
        step4Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">account_balance_wallet</span>`;
      }
      if (step4Tag) {
        step4Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-slate-500 bg-slate-200 px-2 py-0.5 rounded-md';
        step4Tag.textContent = 'STEP 4';
      }
      step4Title.textContent = 'Payment Started';
      step4Desc.textContent = 'Launch GPay / PhonePe / Paytm.';
      step4Time.className = 'pt-2 border-t border-slate-200/60 text-[10px] text-slate-400 font-medium';
      step4Time.textContent = 'Pending';
    }
  }

  // --- Step 5: Paid & Confirmed ---
  const stepCard5 = document.getElementById('stepCard5');
  const step5Icon = document.getElementById('step5Icon');
  const step5Tag = document.getElementById('step5Tag');
  const step5Title = document.getElementById('step5Title');
  const step5Desc = document.getElementById('step5Desc');
  const step5Time = document.getElementById('step5Time');

  if (stepCard5 && step5Title && step5Desc && step5Time) {
    if (isPaid) {
      stepCard5.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-emerald-50/60 border-emerald-200';
      if (step5Icon) {
        step5Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-emerald-100 text-emerald-700';
        step5Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">task_alt</span>`;
      }
      if (step5Tag) {
        step5Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md';
        step5Tag.textContent = 'STEP 5 • SETTLED';
      }
      step5Title.textContent = 'Paid & Confirmed';
      step5Desc.textContent = `Verified Bank UTR: ${order.utr || 'Auto-Verified'}. Logged for dispatch.`;
      step5Time.className = 'pt-2 border-t border-emerald-100 text-[10px] text-emerald-700 font-semibold';
      step5Time.textContent = `Confirmed ${formatStepTime(order.paidAt || steps.paymentConfirmed?.time || order.createdAt)}`;
    } else if (isRedirected) {
      stepCard5.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-purple-50/70 border-purple-300 ring-2 ring-purple-200/80 shadow-sm';
      if (step5Icon) {
        step5Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-purple-100 text-purple-700';
        step5Icon.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">sync</span>`;
      }
      if (step5Tag) {
        step5Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-purple-700 bg-purple-100 px-2 py-0.5 rounded-md flex items-center gap-1';
        step5Tag.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-purple-500 animate-ping"></span> VERIFYING`;
      }
      step5Title.textContent = 'Awaiting Bank Alert';
      const manualConfirmBtn = currentRole === 'OWNER' ? `
        <button type="button" onclick="markCockpitOrderPaid()" class="w-full mt-2 py-1.5 px-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 shadow-2xs transition-all cursor-pointer">
          <span class="material-symbols-outlined text-[14px]">check_circle</span>
          <span>Mark Paid Manually</span>
        </button>` : '';
      step5Desc.innerHTML = `Scanning inbox for incoming bank credit of ₹${payableAmt}...${manualConfirmBtn}`;
      step5Time.className = 'pt-2 border-t border-purple-200/70 text-[10px] text-purple-800 font-bold';
      step5Time.textContent = 'Listening live';
    } else {
      stepCard5.className = 'step-card p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 bg-slate-50 border-slate-200 opacity-60';
      if (step5Icon) {
        step5Icon.className = 'w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold bg-slate-200 text-slate-600';
        step5Icon.innerHTML = `<span class="material-symbols-outlined text-[17px]">task_alt</span>`;
      }
      if (step5Tag) {
        step5Tag.className = 'text-[10px] font-extrabold uppercase tracking-wider text-slate-500 bg-slate-200 px-2 py-0.5 rounded-md';
        step5Tag.textContent = 'STEP 5';
      }
      step5Title.textContent = 'Paid & Confirmed';
      const manualConfirmBtn = currentRole === 'OWNER' ? `
        <button type="button" onclick="markCockpitOrderPaid()" class="w-full mt-2 py-1.5 px-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 shadow-2xs transition-all cursor-pointer">
          <span class="material-symbols-outlined text-[14px]">check_circle</span>
          <span>Mark Paid Manually</span>
        </button>` : '';
      step5Desc.innerHTML = `Awaiting verified bank settlement.${manualConfirmBtn}`;
      step5Time.className = 'pt-2 border-t border-slate-200/60 text-[10px] text-slate-400 font-medium';
      step5Time.textContent = 'Pending settlement';
    }
  }

  // Radar Banner (Strict Priority: isPaid -> isRedirected -> isAddressAdded -> isOpened -> waiting)
  const cockpitRadarBanner = document.getElementById('cockpitRadarBanner');
  if (cockpitRadarBanner) {
    if (isPaid) {
      cockpitRadarBanner.className = 'p-4 rounded-2xl border flex items-center justify-between gap-3 text-xs bg-emerald-50/70 border-emerald-200';
      cockpitRadarBanner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold shrink-0">
            <span class="material-symbols-outlined text-[20px]">task_alt</span>
          </div>
          <div>
            <p class="font-bold text-slate-900">Payment Confirmed & Order Reserved!</p>
            <p class="text-slate-500 mt-0.5">Bank Reference <b>${escapeHtml(order.utr || 'Auto-Verified')}</b> recorded. Ready for packaging & dispatch.</p>
          </div>
        </div>
        <button type="button" onclick="setMasterTab('dispatch')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition-colors shrink-0 whitespace-nowrap cursor-pointer">
          Open Dispatch Board →
        </button>
      `;
    } else if (isRedirected) {
      cockpitRadarBanner.className = 'p-4 rounded-2xl border flex items-center justify-between gap-3 text-xs bg-purple-50/70 border-purple-200 ring-1 ring-purple-300';
      cockpitRadarBanner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-purple-100 text-purple-700 flex items-center justify-center font-bold shrink-0">
            <span class="material-symbols-outlined text-[20px] animate-pulse">account_balance_wallet</span>
          </div>
          <div>
            <p class="font-bold text-slate-900">Customer launched ${escapeHtml(steps.redirectedToPayment?.app || 'UPI App')}!</p>
            <p class="text-slate-500 mt-0.5">Awaiting incoming bank credit confirmation for exact amount <b>₹${payableAmt}</b>...</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 flex-wrap">
          <button type="button" onclick="markCockpitOrderPaid()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs flex items-center gap-1 shadow-sm cursor-pointer transition-all" title="Manually verify & mark PAID">
            <span class="material-symbols-outlined text-[15px]">check_circle</span>
            <span>Confirm Payment</span>
          </button>
          <button type="button" onclick="triggerTestBankWebhook()" class="px-3 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-800 font-bold rounded-xl text-xs flex items-center gap-1 border border-purple-300 cursor-pointer transition-all" title="Simulate bank alert for this order">
            <span class="material-symbols-outlined text-[15px]">flash_on</span>
            <span>Simulate Bank Alert</span>
          </button>
        </div>
      `;
    } else if (isAddressAdded) {
      cockpitRadarBanner.className = 'p-4 rounded-2xl border flex items-center justify-between gap-3 text-xs bg-indigo-50/70 border-indigo-200';
      cockpitRadarBanner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold shrink-0">
            <span class="material-symbols-outlined text-[20px]">local_shipping</span>
          </div>
          <div>
            <p class="font-bold text-slate-900">Customer saved delivery address! High-intent buyer.</p>
            <p class="text-slate-500 mt-0.5">Shipping to ${escapeHtml(order.address?.city || 'destination')}. Awaiting UPI payment completion.</p>
          </div>
        </div>
        <button type="button" onclick="openWhatsAppForCockpit()" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs transition-colors shrink-0 whitespace-nowrap cursor-pointer">
          Send Friendly WhatsApp Nudge
        </button>
      `;
    } else if (isOpened) {
      cockpitRadarBanner.className = 'p-4 rounded-2xl border flex items-center justify-between gap-3 text-xs bg-blue-50/70 border-blue-200';
      cockpitRadarBanner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center font-bold shrink-0">
            <span class="material-symbols-outlined text-[20px]">touch_app</span>
          </div>
          <div>
            <p class="font-bold text-slate-900">Customer opened checkout page & is reviewing order.</p>
            <p class="text-slate-500 mt-0.5">Customer is reviewing specifications and entering delivery address on their phone.</p>
          </div>
        </div>
        <span class="px-3 py-1 bg-blue-100 text-blue-800 font-bold rounded-xl text-[11px] border border-blue-200 shrink-0">
          Customer Active
        </span>
      `;
    } else {
      cockpitRadarBanner.className = 'p-4 rounded-2xl border flex items-center justify-between gap-3 text-xs bg-amber-50/70 border-amber-200';
      cockpitRadarBanner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center font-bold shrink-0">
            <span class="material-symbols-outlined text-[20px] animate-spin">radar</span>
          </div>
          <div>
            <p class="font-bold text-slate-900">Waiting for customer response</p>
            <p class="text-slate-500 mt-0.5">Order link shared via WhatsApp. Waiting for customer to open link on mobile...</p>
          </div>
        </div>
        <button type="button" onclick="openWhatsAppForCockpit()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition-colors shrink-0 whitespace-nowrap cursor-pointer">
          Re-send WhatsApp Link
        </button>
      `;
    }
  }

  // Order Fulfillment & Delivery Record Row Preview
  const spreadsheetRowTbody = document.getElementById('spreadsheetRowTbody');
  if (spreadsheetRowTbody) {
    const addressStr = order.address 
      ? `${escapeHtml(order.address.flat)}, ${escapeHtml(order.address.street || '')}, ${escapeHtml(order.address.city)} - ${escapeHtml(order.address.pincode)}`
      : `<span class="text-slate-400 italic">Awaiting customer entry on checkout</span>`;

    const paymentCol = isPaid
      ? `<span class="font-mono font-bold text-emerald-700 flex items-center gap-1.5">
           <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
           ${escapeHtml(order.utr || 'Auto-Verified')}
         </span>`
      : `<span class="text-amber-700 font-medium italic flex items-center gap-1">
           <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
           Pending Settlement
         </span>`;

    const dispatchCol = isPaid
      ? `<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px] border border-emerald-200">READY TO SHIP</span>`
      : `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px] border border-amber-200">AWAITING PAYMENT</span>`;

    spreadsheetRowTbody.innerHTML = `
      <tr class="hover:bg-slate-50 transition-colors">
        <td class="py-3 px-3 font-mono font-bold text-indigo-600 whitespace-nowrap">
          #REF-${escapeHtml(order.ref)}
        </td>
        <td class="py-3 px-3 whitespace-nowrap">
          <span class="font-bold text-slate-900 block">${escapeHtml((order.customerName || '').trim() || `#REF-${order.ref}`)}</span>
          <span class="text-slate-400 font-mono text-[10px]">${order.customerPhone ? '+91 ' + escapeHtml(order.customerPhone) : '—'}</span>
        </td>
        <td class="py-3 px-3 max-w-xs truncate text-slate-700 font-medium">
          ${order.sku ? `<span class="font-mono text-indigo-600 font-bold text-[10px] mr-1">#${escapeHtml(order.sku)}</span>` : ''}
          ${escapeHtml(order.itemDescription)}
        </td>
        <td class="py-3 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
          ₹${payableAmt}
        </td>
        <td class="py-3 px-3 whitespace-nowrap">
          ${paymentCol}
        </td>
        <td class="py-3 px-3 text-slate-600 max-w-sm text-[11px]">
          ${addressStr}
        </td>
        <td class="py-3 px-3 whitespace-nowrap">
          ${dispatchCol}
        </td>
      </tr>
    `;
  }
}

// Adjust order amount via pill buttons
function adjustAmount(delta) {
  const input = document.getElementById('orderValue');
  let val = parseInt(input.value) || 0;
  val += delta;
  input.value = Math.max(val, 50);
  syncLivePitch();
}

function setExactAmount(amount) {
  const input = document.getElementById('orderValue');
  input.value = amount;
  syncLivePitch();
}

function clearForm() {
  const custName = document.getElementById('custName');
  const custPhone = document.getElementById('custPhone');
  const itemSku = document.getElementById('itemSku');
  const itemDesc = document.getElementById('itemDesc');
  const orderValue = document.getElementById('orderValue');
  const internalNotes = document.getElementById('internalNotes');
  const catalogSelect = document.getElementById('catalogSelect');
  const chkSaveToCatalog = document.getElementById('chkSaveToCatalog');
  const skuStatusNotice = document.getElementById('skuStatusNotice');

  if (custName) custName.value = "";
  if (custPhone) custPhone.value = "";
  if (itemSku) itemSku.value = "";
  if (itemDesc) itemDesc.value = "";
  if (orderValue) orderValue.value = "";
  if (internalNotes) internalNotes.value = "";
  if (catalogSelect) catalogSelect.value = "";
  if (chkSaveToCatalog) chkSaveToCatalog.checked = false;
  if (skuStatusNotice) skuStatusNotice.textContent = "Printed on bill";

  // Hide WhatsApp button before generation
  const preNotice = document.getElementById('preGenerateNotice');
  const postActions = document.getElementById('postGenerateActions');
  if (preNotice) preNotice.classList.remove('hidden');
  if (postActions) postActions.classList.add('hidden');

  activeRefNumber = null;
  syncLivePitch();
  showToast("Quick Checkout Builder cleared");
}

function syncLivePitch() {
  const name = (document.getElementById('custName')?.value || '').trim();
  const item = (document.getElementById('itemDesc')?.value || '').trim();
  const amountVal = document.getElementById('orderValue')?.value;
  const amount = parseFloat(amountVal || 0);

  const pitchPreview = document.getElementById('pitchPreview');
  const displayUrl = document.getElementById('displayUrl');
  const charCount = document.getElementById('charCount');
  const btnOpenCheckoutTab = document.getElementById('btnOpenCheckoutTab');
  const qrUrlDisplay = document.getElementById('qrUrlDisplay');
  const qrAmountDisplay = document.getElementById('qrAmountDisplay');
  const activeRailRefBadge = document.getElementById('activeRailRefBadge');

  if (!name && !item && !amount) {
    if (pitchPreview) {
      pitchPreview.innerHTML = `<span class="text-slate-400 italic">Select an item from the database or enter details on the left to generate your live WhatsApp pitch and checkout rail.</span>`;
    }
    if (displayUrl) {
      displayUrl.textContent = 'Link will be generated upon creation';
      displayUrl.removeAttribute('href');
    }
    if (charCount) charCount.textContent = '0 chars • Ready to generate';
    if (qrAmountDisplay) qrAmountDisplay.textContent = '₹0.00';
    if (activeRailRefBadge) activeRailRefBadge.textContent = 'READY TO CREATE';
    return;
  }

  const formattedAmount = '₹' + Math.floor(amount).toLocaleString('en-IN');
  const origin = window.location.origin;
  const url = activeRefNumber ? `${origin}/pay?ref=${activeRefNumber}` : `${origin}/pay`;
  
  const cleanPitchName = name.trim();
  const greeting = cleanPitchName ? `Hi ${cleanPitchName.split(' ')[0]}!` : 'Hello!';
  const brand = (currentSeller && currentSeller.brandName) || 'Store';
  const pitch = `${greeting} ✨ Your order for *${item || 'Product'}* (${formattedAmount}) with ${brand} is ready.\n\nTap below to confirm your shipping address & pay securely via GPay/PhonePe/UPI:\n👉 ${url}\n\nFast express dispatch upon confirmation!`;

  if (pitchPreview) pitchPreview.textContent = pitch;
  if (displayUrl) {
    displayUrl.textContent = url;
    displayUrl.href = url;
  }
  if (btnOpenCheckoutTab) btnOpenCheckoutTab.href = url;
  if (charCount) charCount.textContent = `${pitch.length} chars • Live instant pitch`;
  if (qrUrlDisplay) qrUrlDisplay.textContent = url;
  if (qrAmountDisplay) qrAmountDisplay.textContent = formattedAmount;
  if (activeRailRefBadge) {
    activeRailRefBadge.textContent = activeRefNumber ? `REF #${activeRefNumber} • READY` : 'READY TO CREATE';
  }

  // Handle post-generation container state
  const preNotice = document.getElementById('preGenerateNotice');
  const postActions = document.getElementById('postGenerateActions');
  if (!activeRefNumber) {
    if (preNotice) preNotice.classList.remove('hidden');
    if (postActions) postActions.classList.add('hidden');
  } else {
    if (preNotice) preNotice.classList.add('hidden');
    if (postActions) postActions.classList.remove('hidden');
  }
}

// Mutex lock to prevent duplicate order generation
let isCreatingOrder = false;

// Generate new sale from the builder form (Unified 1-Tap WhatsApp Flow)
async function handleCreateOrder() {
  if (isCreatingOrder) return;
  isCreatingOrder = true;

  const submitBtn = document.getElementById('btnSubmitGenerate');
  const origBtnContent = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">refresh</span><span>Creating &amp; Opening WhatsApp...</span>`;
  }

  const custName = (document.getElementById('custName')?.value || '').trim();
  const custPhone = (document.getElementById('custPhone')?.value || '').trim();
  const itemSku = (document.getElementById('itemSku')?.value || '').trim();
  const itemDesc = (document.getElementById('itemDesc')?.value || '').trim();
  const orderAmount = document.getElementById('orderValue')?.value;
  const notes = (document.getElementById('internalNotes')?.value || '').trim();
  const saveToCatalog = document.getElementById('chkSaveToCatalog')?.checked || false;

  // Pre-open a blank window synchronously during user gesture to prevent popup blockers
  let waWindow = null;
  try {
    waWindow = window.open('about:blank', '_blank');
  } catch (e) {
    waWindow = null;
  }

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        customerName: custName,
        customerPhone: custPhone,
        sku: itemSku,
        itemDescription: itemDesc,
        amount: orderAmount,
        notes: notes,
        saveToCatalog: saveToCatalog
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      if (waWindow && !waWindow.closed) waWindow.close();
      showToast('⚠️ ' + (data.error || 'Failed to create order link'));
      return;
    }

    activeRefNumber = data.order.ref;
    activeOrder = data.order;
    
    // Refresh background metrics and product stock in catalog
    await fetchOrdersAndMetrics();
    await fetchProductCatalog();

    // Update live pitch preview with generated REF and exact amount
    syncLivePitch();

    // Populate the post-generation rail actions
    const preNotice = document.getElementById('preGenerateNotice');
    const postActions = document.getElementById('postGenerateActions');
    const postGenOrderRefTitle = document.getElementById('postGenOrderRefTitle');
    const postGenAmountTitle = document.getElementById('postGenAmountTitle');

    if (preNotice) preNotice.classList.add('hidden');
    if (postActions) postActions.classList.remove('hidden');

    if (postGenOrderRefTitle) postGenOrderRefTitle.textContent = `Order Link #REF-${data.order.ref} Ready!`;
    if (postGenAmountTitle) postGenAmountTitle.textContent = `₹${data.order.payableAmount.toLocaleString('en-IN')}`;

    // Direct pre-opened window to WhatsApp, or handle popup blocker gracefully
    let openedAutomatically = false;
    if (data.waLink && waWindow && !waWindow.closed) {
      try {
        waWindow.location.href = data.waLink;
        openedAutomatically = true;
      } catch (e) {
        openedAutomatically = false;
      }
    }

    if (openedAutomatically) {
      showToast(`✅ Order #REF-${activeRefNumber} Ready! WhatsApp opened in new tab.`);
    } else {
      if (waWindow && !waWindow.closed) waWindow.close();
      showToast(`✅ Order #REF-${activeRefNumber} Ready! Tap Re-open chat if popup was blocked.`);
    }

    // Instantly switch straight to Live Cockpit for this order so the seller tracks the customer journey in real-time!
    activateTab(data.order.ref);

  } catch (err) {
    if (waWindow && !waWindow.closed) waWindow.close();
    console.error(err);
    showToast('⚠️ Error connecting to server');
  } finally {
    isCreatingOrder = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origBtnContent;
    }
  }
}

let lastOrdersDataSnapshot = '';
let knownPaidOrderRefs = null;

// Polling radar: fetch latest orders and update KPIs, active tab cockpit, and table
async function fetchOrdersAndMetrics() {
  try {
    const res = await fetch('/api/orders', {
      headers: getAuthHeaders()
    });
    if (res.status === 401) {
      window.location.href = '/auth';
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    cachedOrders = data.orders || [];
    const m = data.metrics || {};

    // Seed or detect newly settled/paid orders in real-time
    if (knownPaidOrderRefs === null) {
      knownPaidOrderRefs = new Set(cachedOrders.filter(o => o.status === 'PAID').map(o => String(o.ref)));
    } else {
      const newlyPaid = cachedOrders.filter(o => o.status === 'PAID' && !knownPaidOrderRefs.has(String(o.ref)));
      if (newlyPaid.length > 0) {
        newlyPaid.forEach(o => knownPaidOrderRefs.add(String(o.ref)));
        const latestPaid = newlyPaid[0];
        const payable = (latestPaid.payableAmount !== undefined ? latestPaid.payableAmount : latestPaid.amount).toFixed(2);

        playSellerCelebrationChime();
        triggerSellerConfetti();
        showToast(`🎉 Payment Confirmed! Order #${latestPaid.ref} received ₹${payable} via Bank UPI!`);

        // Automatically switch and render cockpit if on this order or on 'NEW'
        if (activeTab === String(latestPaid.ref) || activeTab === 'NEW' || activeTab === latestPaid.token) {
          activateTab(latestPaid.ref);
        }
      }
    }

    // Update Top KPIs
    const kpiCreated = document.getElementById('kpiCreated');
    const kpiRevenue = document.getElementById('kpiRevenue');
    const kpiPaidCount = document.getElementById('kpiPaidCount');
    const kpiPaidPercent = document.getElementById('kpiPaidPercent');
    const nextRefBadge = document.getElementById('nextRefBadge');

    if (kpiCreated) kpiCreated.textContent = m.totalOrders || 0;
    if (kpiRevenue) kpiRevenue.textContent = `₹${(m.revenue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kpiPaidCount) {
      const pct = m.totalOrders > 0 ? Math.round((m.paidCount / m.totalOrders) * 100) : 0;
      kpiPaidCount.innerHTML = `${m.paidCount} <span class="text-sm font-semibold text-emerald-600">(${pct}%)</span>`;
      if (kpiPaidPercent) kpiPaidPercent.textContent = `${pct}%`;
    }

    // Filter counts
    const fAll = document.getElementById('filterCountAll');
    const fPending = document.getElementById('filterCountPending');
    const fPaid = document.getElementById('filterCountPaid');
    if (fAll) fAll.textContent = m.totalOrders || 0;
    if (fPending) fPending.textContent = m.pendingCount || 0;
    if (fPaid) fPaid.textContent = m.paidCount || 0;

    // Next Ref calculation with full alphanumeric support (e.g. ACH-038 -> ACH-039)
    const nextRefText = computeNextRef(cachedOrders);
    document.querySelectorAll('#nextRefBadge, .next-ref-badge').forEach(badge => {
      badge.textContent = `Next Ref: #${nextRefText}`;
    });

    // Save master breakdown if present
    if (data.salesmenBreakdown) cachedSalesmenBreakdown = data.salesmenBreakdown || [];
    if (data.allSalesmen) cachedAllSalesmen = data.allSalesmen || [];
    if (data.storeFunnel) cachedStoreFunnel = data.storeFunnel;
    if (data.abandonedLeads) cachedAbandonedLeads = data.abandonedLeads || [];

    // Change Detection: Eliminate DOM thrashing if server state hasn't changed
    const currentSnapshot = JSON.stringify({
      orders: data.orders,
      funnel: data.storeFunnel,
      leads: data.abandonedLeads,
      salesmen: data.salesmenBreakdown,
      activeTab,
      mainView: currentMainView,
      actionQueue: currentActionQueue
    });

    const hasChanged = currentSnapshot !== lastOrdersDataSnapshot;
    if (hasChanged) {
      lastOrdersDataSnapshot = currentSnapshot;

      // Render Tabs Rail
      renderTabs();

      // If an individual sale tab is currently active, refresh its cockpit view
      if (activeTab !== 'NEW') {
        const target = activeTab.trim().toLowerCase();
        const updatedOrder = cachedOrders.find(o => 
          String(o.ref).toLowerCase() === target || 
          (o.token && o.token.toLowerCase() === target) || 
          String(o.id).toLowerCase() === target ||
          (o.storeRef && String(o.storeRef).toLowerCase() === target)
        );
        if (updatedOrder) {
          activeOrder = updatedOrder;
          renderCockpit(updatedOrder);
        }
      }

      // If an action queue is open, refresh it
      if (currentActionQueue) {
        renderActionQueueContent();
      }

      // Render Bottom Table
      renderOrdersTable();

      // If currently on Master Dashboard view, refresh active sub-tab
      if (currentMainView === 'MASTER') {
        renderActiveMasterView();
      }
    }

  } catch (err) {
    console.error('Failed to fetch orders:', err);
  }
}

// Seller Celebration Sound Chime via Web Audio API
function playSellerCelebrationChime() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
    osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.12); // E5
    osc.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.24); // G5
    osc.frequency.exponentialRampToValueAtTime(1046.50, audioCtx.currentTime + 0.36); // C6

    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.7);
  } catch (e) {}
}

// Seller Confetti Celebration Particle FX
function triggerSellerConfetti() {
  try {
    const count = 30;
    const colors = ['#10b981', '#6366f1', '#f59e0b', '#ec4899', '#3b82f6'];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.style.position = 'fixed';
      p.style.width = '8px';
      p.style.height = '8px';
      p.style.borderRadius = '2px';
      p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      p.style.left = (window.innerWidth / 2 + (Math.random() - 0.5) * 260) + 'px';
      p.style.top = (window.innerHeight / 3 + (Math.random() - 0.5) * 120) + 'px';
      p.style.zIndex = '99999';
      p.style.pointerEvents = 'none';
      p.style.transition = 'all 1.1s cubic-bezier(0.2, 0.8, 0.2, 1)';
      document.body.appendChild(p);

      setTimeout(() => {
        p.style.transform = `translate(${(Math.random() - 0.5) * 450}px, ${Math.random() * 320 + 80}px) rotate(${Math.random() * 360}deg)`;
        p.style.opacity = '0';
      }, 20);

      setTimeout(() => {
        if (p.parentElement) p.parentElement.removeChild(p);
      }, 1200);
    }
  } catch (e) {}
}

// Next Ref calculation helper (extracts prefix & increments numeric tail)
function computeNextRef(orders) {
  let prefix = '';
  let maxNum = 0;
  let numDigits = 0;

  (orders || []).forEach(o => {
    const refStr = String(o.ref || '');
    const match = refStr.match(/^([A-Za-z]+[-_]?)?(\d+)$/);
    if (match) {
      const n = parseInt(match[2], 10);
      if (!isNaN(n) && n > maxNum) {
        maxNum = n;
        numDigits = match[2].length;
        if (match[1]) prefix = match[1];
      }
    }
  });

  if (maxNum > 0) {
    const nextNum = maxNum + 1;
    const padded = numDigits > 0 ? String(nextNum).padStart(numDigits, '0') : String(nextNum);
    return prefix ? `${prefix}${padded}` : `${nextNum}`;
  }
  return '101';
}

// Master Dashboard State
let currentMasterTab = 'overview'; // 'overview', 'dispatch', or 'settings'
let dispFilterSalesman = 'ALL';
let dispFilterStatus = 'ALL';

// Switch between Sales Cockpit (Studio) and Master Dashboard (Owner)
window.switchToStudioCockpit = function() {
  switchMainView('STUDIO');
  activateTab('NEW');
};

function switchMainView(view) {
  if (currentRole === 'SALESMAN' && view === 'MASTER') {
    if (!currentStockAccess && currentMasterTab !== 'dispatch') {
      currentMasterTab = 'dispatch';
    }
  }

  currentMainView = view;
  const sectionStudio = document.getElementById('sectionStudio');
  const sectionMaster = document.getElementById('sectionMaster');
  const btnStudio = document.getElementById('mTabBtnStudio');

  const activeHeaderClass = 'px-3.5 py-1.5 rounded-full bg-white text-slate-900 shadow-xs border border-slate-200/80 transition-all cursor-pointer font-bold flex items-center gap-1.5';
  const inactiveHeaderClass = 'px-3.5 py-1.5 rounded-full text-slate-600 hover:text-slate-900 hover:bg-white/60 transition-colors cursor-pointer font-semibold flex items-center gap-1.5';

  if (view === 'MASTER') {
    if (sectionStudio) sectionStudio.classList.add('hidden');
    if (sectionMaster) sectionMaster.classList.remove('hidden');
    if (btnStudio) btnStudio.className = inactiveHeaderClass;
    renderActiveMasterView();
  } else {
    if (sectionMaster) sectionMaster.classList.add('hidden');
    if (sectionStudio) sectionStudio.classList.remove('hidden');
    if (btnStudio) btnStudio.className = activeHeaderClass;
    // Set all master subtabs to inactive in header
    ['mTabBtnOverview', 'mTabBtnInventory', 'mTabBtnDispatch', 'mTabBtnSettings'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.className = inactiveHeaderClass;
    });
  }

  // Ensure role permissions are strictly preserved on view transitions
  syncNavTabsVisibility();
}

// Synchronize Navigation Tabs visibility strictly according to user role and permissions
function syncNavTabsVisibility() {
  const isSalesman = currentRole === 'SALESMAN';
  const hasStockAccess = isSalesman ? Boolean(currentStockAccess) : true;

  // Header Nav buttons
  const mTabOverview = document.getElementById('mTabBtnOverview');
  const mTabSettings = document.getElementById('mTabBtnSettings');
  const mTabInventory = document.getElementById('mTabBtnInventory');
  const mTabDispatch = document.getElementById('mTabBtnDispatch');
  const mBtnQuickSale = document.getElementById('mBtnQuickSale');
  const navOrdersLabel = document.getElementById('navOrdersLabel');

  if (mTabOverview) {
    if (isSalesman) {
      mTabOverview.classList.add('hidden');
      mTabOverview.style.setProperty('display', 'none', 'important');
    } else {
      mTabOverview.classList.remove('hidden');
      mTabOverview.style.display = '';
    }
  }

  if (mTabSettings) {
    if (isSalesman) {
      mTabSettings.classList.add('hidden');
      mTabSettings.style.setProperty('display', 'none', 'important');
    } else {
      mTabSettings.classList.remove('hidden');
      mTabSettings.style.display = '';
    }
  }

  if (mTabInventory) {
    if (!hasStockAccess) {
      mTabInventory.classList.add('hidden');
      mTabInventory.style.setProperty('display', 'none', 'important');
    } else {
      mTabInventory.classList.remove('hidden');
      mTabInventory.style.display = '';
    }
  }

  if (mTabDispatch) {
    mTabDispatch.classList.remove('hidden');
    mTabDispatch.style.display = '';
    if (navOrdersLabel) {
      navOrdersLabel.textContent = isSalesman ? 'My Orders' : 'Orders & Dispatch';
    }
  }

  if (mBtnQuickSale) {
    mBtnQuickSale.classList.add('hidden');
    mBtnQuickSale.style.setProperty('display', 'none', 'important');
  }

  // Mobile Bottom Nav Dock buttons
  const mNavOverview = document.getElementById('mNavBtnOverview');
  const mNavSettings = document.getElementById('mNavBtnSettings');
  const mNavInventory = document.getElementById('mNavBtnInventory');
  const mNavDispatch = document.getElementById('mNavBtnDispatch');

  if (mNavOverview) {
    if (isSalesman) {
      mNavOverview.classList.add('hidden');
      mNavOverview.style.setProperty('display', 'none', 'important');
    } else {
      mNavOverview.classList.remove('hidden');
      mNavOverview.style.display = '';
    }
  }

  if (mNavSettings) {
    if (isSalesman) {
      mNavSettings.classList.add('hidden');
      mNavSettings.style.setProperty('display', 'none', 'important');
    } else {
      mNavSettings.classList.remove('hidden');
      mNavSettings.style.display = '';
    }
  }

  if (mNavInventory) {
    if (!hasStockAccess) {
      mNavInventory.classList.add('hidden');
      mNavInventory.style.setProperty('display', 'none', 'important');
    } else {
      mNavInventory.classList.remove('hidden');
      mNavInventory.style.display = '';
    }
  }

  if (mNavDispatch) {
    const mobileOrdersText = mNavDispatch.querySelector('span:last-child');
    if (mobileOrdersText) {
      mobileOrdersText.textContent = isSalesman ? 'My Orders' : 'Dispatch';
    }
  }
}

// Master Dashboard Sub-Tabs Switching (Overview vs Dispatch Board vs Settings vs Inventory)
function setMasterTab(tabName) {
  if (currentRole === 'SALESMAN') {
    if (tabName !== 'inventory' && tabName !== 'dispatch') {
      showToast('⚠️ Access denied. Overview and Settings are restricted to Store Owner.');
      switchMainView('STUDIO');
      syncNavTabsVisibility();
      return;
    }
    if (tabName === 'inventory' && !currentStockAccess) {
      showToast('⚠️ Access denied. Stock CRM access has not been granted by Store Owner.');
      switchMainView('STUDIO');
      syncNavTabsVisibility();
      return;
    }
  }

  currentMasterTab = tabName;

  if (currentMainView !== 'MASTER') {
    switchMainView('MASTER');
  }

  const btnOverview = document.getElementById('mTabBtnOverview');
  const btnDispatch = document.getElementById('mTabBtnDispatch');
  const btnSettings = document.getElementById('mTabBtnSettings');
  const btnInventory = document.getElementById('mTabBtnInventory');

  const viewOverview = document.getElementById('mViewOverview');
  const viewDispatch = document.getElementById('mViewDispatch');
  const viewSettings = document.getElementById('mViewSettings');
  const viewInventory = document.getElementById('mViewInventory');

  // Reset tab button styles
  const activeClass = 'px-3.5 py-1.5 rounded-full bg-white text-slate-900 shadow-xs border border-slate-200/80 transition-all cursor-pointer font-bold flex items-center gap-1.5';
  const inactiveClass = 'px-3.5 py-1.5 rounded-full text-slate-600 hover:text-slate-900 hover:bg-white/60 transition-colors cursor-pointer font-semibold flex items-center gap-1.5';

  if (btnOverview) btnOverview.className = tabName === 'overview' ? activeClass : inactiveClass;
  if (btnDispatch) btnDispatch.className = tabName === 'dispatch' ? activeClass : inactiveClass;
  if (btnSettings) btnSettings.className = tabName === 'settings' ? activeClass : inactiveClass;
  if (btnInventory) btnInventory.className = tabName === 'inventory' ? activeClass : inactiveClass;

  if (viewOverview) viewOverview.classList.toggle('hidden', tabName !== 'overview');
  if (viewDispatch) viewDispatch.classList.toggle('hidden', tabName !== 'dispatch');
  if (viewSettings) viewSettings.classList.toggle('hidden', tabName !== 'settings');
  if (viewInventory) viewInventory.classList.toggle('hidden', tabName !== 'inventory');

  // Sync Mobile Bottom Nav Dock styles
  const mNavOverview = document.getElementById('mNavBtnOverview');
  const mNavInventory = document.getElementById('mNavBtnInventory');
  const mNavDispatch = document.getElementById('mNavBtnDispatch');
  const mNavSettings = document.getElementById('mNavBtnSettings');

  const mActive = 'flex-1 py-1 flex flex-col items-center justify-center text-indigo-600 transition-colors font-bold cursor-pointer';
  const mInactive = 'flex-1 py-1 flex flex-col items-center justify-center text-slate-400 hover:text-slate-600 transition-colors font-medium cursor-pointer';

  if (mNavOverview) mNavOverview.className = tabName === 'overview' ? mActive : mInactive;
  if (mNavInventory) mNavInventory.className = tabName === 'inventory' ? mActive : mInactive;
  if (mNavDispatch) mNavDispatch.className = tabName === 'dispatch' ? mActive : mInactive;
  if (mNavSettings) mNavSettings.className = tabName === 'settings' ? mActive : mInactive;

  // Strict role enforcement: hide tabs if not allowed
  syncNavTabsVisibility();

  if (tabName === 'settings') {
    loadStoreSettings();
    renderMasterDashboard();
  }

  renderActiveMasterView();
}

function renderActiveMasterView() {
  if (currentRole !== 'OWNER' && !currentStockAccess && currentMasterTab !== 'dispatch') return;
  if (currentMasterTab === 'overview') {
    renderMasterDashboard();
  } else if (currentMasterTab === 'dispatch') {
    renderMasterDispatchTable();
  } else if (currentMasterTab === 'settings') {
    renderMasterDashboard();
  } else if (currentMasterTab === 'inventory') {
    renderStockCrmTable();
  }
}

// 1. Render Master Overview & Salesmen Performance Table
function renderMasterDashboard() {
  if (currentRole !== 'OWNER') return;

  const masterStoreTitle = document.getElementById('masterStoreTitle');
  const masterRevenue = document.getElementById('masterRevenue');
  const masterTotalOrders = document.getElementById('masterTotalOrders');
  const masterPaidCount = document.getElementById('masterPaidCount');
  const masterConversionRate = document.getElementById('masterConversionRate');
  const masterStaffCount = document.getElementById('masterStaffCount');
  const masterSalesmenTbody = document.getElementById('masterSalesmenTbody');

  if (masterStoreTitle && currentSeller) {
    masterStoreTitle.textContent = `${currentSeller.brandName} • Master Dashboard`;
  }

  // Calculate master aggregates across cachedSalesmenBreakdown or storeFunnel
  let totalRev = 0;
  let totalOrders = 0;
  let totalPaid = 0;

  if (cachedStoreFunnel) {
    totalRev = cachedStoreFunnel.revenue || 0;
    totalOrders = cachedStoreFunnel.sent || 0;
    totalPaid = cachedStoreFunnel.paid || 0;
  } else {
    cachedSalesmenBreakdown.forEach(sm => {
      totalRev += (sm.revenue || 0);
      totalOrders += (sm.totalOrders || 0);
      totalPaid += (sm.paidOrders || 0);
    });
  }

  const conversionPct = totalOrders > 0 ? Math.round((totalPaid / totalOrders) * 100) : 0;

  if (masterRevenue) masterRevenue.textContent = `₹${totalRev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (masterTotalOrders) masterTotalOrders.textContent = totalOrders;
  if (masterPaidCount) masterPaidCount.textContent = totalPaid;
  if (masterConversionRate) masterConversionRate.textContent = `${conversionPct}% conversion rate`;
  if (masterStaffCount) masterStaffCount.textContent = cachedSalesmenBreakdown.length;

  // POPULATE STORE COMMERCIAL CONVERSION FUNNEL RIBBON
  if (cachedStoreFunnel) {
    const f = cachedStoreFunnel;
    const fSent = f.sent || 0;
    const fViewed = f.viewed || 0;
    const fAddr = f.addressAdded || 0;
    const fPayStarted = f.paymentStarted || 0;
    const fPaid = f.paid || 0;
    const fRev = f.revenue || 0;
    const fConv = f.conversionRate || 0;

    const elBadge = document.getElementById('funnelConversionBadge');
    const elSent = document.getElementById('funnelSent');
    const elViewed = document.getElementById('funnelViewed');
    const elViewedPct = document.getElementById('funnelViewedPct');
    const elAddress = document.getElementById('funnelAddress');
    const elAddressPct = document.getElementById('funnelAddressPct');
    const elPayStarted = document.getElementById('funnelPayStarted');
    const elPayStartedPct = document.getElementById('funnelPayStartedPct');
    const elPaid = document.getElementById('funnelPaid');
    const elPaidRev = document.getElementById('funnelPaidRev');

    if (elBadge) elBadge.textContent = `${fConv}% Conversion`;
    if (elSent) elSent.textContent = fSent;
    if (elViewed) elViewed.textContent = fViewed;
    if (elViewedPct) elViewedPct.textContent = `${fSent > 0 ? Math.round((fViewed / fSent) * 100) : 0}% opened`;
    if (elAddress) elAddress.textContent = fAddr;
    if (elAddressPct) elAddressPct.textContent = `${fSent > 0 ? Math.round((fAddr / fSent) * 100) : 0}% high intent`;
    if (elPayStarted) elPayStarted.textContent = fPayStarted;
    if (elPayStartedPct) elPayStartedPct.textContent = `${fSent > 0 ? Math.round((fPayStarted / fSent) * 100) : 0}% launched`;
    if (elPaid) elPaid.textContent = fPaid;
    if (elPaidRev) elPaidRev.textContent = `₹${fRev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // POPULATE HIGH-INTENT ABANDONED LEADS RECOVERY CARDS
  const abandonedCountBadge = document.getElementById('abandonedCountBadge');
  const abandonedLeadsContainer = document.getElementById('abandonedLeadsContainer');

  if (abandonedCountBadge) {
    abandonedCountBadge.textContent = `${cachedAbandonedLeads.length} Lead${cachedAbandonedLeads.length === 1 ? '' : 's'}`;
  }

  if (abandonedLeadsContainer) {
    if (cachedAbandonedLeads.length === 0) {
      abandonedLeadsContainer.innerHTML = `
        <div class="col-span-full py-6 text-center text-slate-500 bg-white/70 rounded-2xl border border-amber-200/50">
          <span class="text-xs font-semibold">🎉 No abandoned customer drop-offs right now! Every customer who entered an address has completed payment.</span>
        </div>
      `;
    } else {
      abandonedLeadsContainer.innerHTML = cachedAbandonedLeads.map(lead => {
        const payableAmt = (lead.payableAmount !== undefined ? lead.payableAmount : lead.amount).toFixed(2);
        const origin = window.location.origin;
        const payUrl = `${origin}/pay?ref=${lead.ref}`;
        const phone = lead.customerPhone || '';
        const addrCity = lead.address ? `${lead.address.city || ''}, ${lead.address.state || ''} (${lead.address.pincode || ''})` : 'Delivery address entered';
        const msg = encodeURIComponent(`Hi ${lead.customerName || 'there'}, your reservation for "${lead.itemDescription}" (₹${payableAmt}) is reserved at ${currentSeller ? currentSeller.brandName : 'our store'}. Complete your delivery confirmation here: ${payUrl}`);
        const waUrl = phone ? `https://wa.me/91${phone}?text=${msg}` : '#';

        return `
          <div class="bg-white rounded-2xl p-4 border border-amber-200/90 shadow-2xs flex flex-col justify-between gap-3 hover:shadow-xs transition-shadow">
            <div>
              <div class="flex items-center justify-between gap-1 mb-1.5">
                <span class="font-mono text-[11px] font-bold text-amber-900 bg-amber-100/80 px-2 py-0.5 rounded-md">#REF-${lead.ref}</span>
                <span class="text-[10px] text-slate-400 font-semibold">${timeAgo(lead.createdAt)}</span>
              </div>
              <div class="font-bold text-slate-900 text-xs truncate">${escapeHtml(lead.customerName || 'Customer')}</div>
              <div class="text-[11px] text-slate-600 truncate mt-0.5">${escapeHtml(lead.itemDescription)} • <strong class="text-slate-900 font-mono">₹${payableAmt}</strong></div>
              <div class="text-[10px] text-indigo-700 bg-indigo-50/70 rounded-lg p-1.5 mt-2 flex items-center gap-1">
                <span class="material-symbols-outlined text-[13px] text-indigo-500">location_on</span>
                <span class="truncate">${escapeHtml(addrCity)}</span>
              </div>
              <div class="text-[10px] text-slate-400 font-medium mt-1">Staff: <strong class="text-slate-600">${escapeHtml(lead.salesmanName || 'Staff Desk')}</strong></div>
            </div>

            <div class="pt-2 border-t border-slate-100 flex items-center gap-2">
              <a href="${waUrl}" target="_blank" class="flex-1 py-1.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors no-underline shadow-2xs cursor-pointer">
                <span class="material-symbols-outlined text-[14px]">chat</span>
                <span>Recover via WhatsApp</span>
              </a>
              <button type="button" onclick="activateTab('${lead.ref}')" class="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition-colors cursor-pointer text-[11px] font-bold" title="Open in Cockpit">
                <span class="material-symbols-outlined text-[15px]">open_in_new</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // POPULATE SALESMEN TEAM FUNNEL DIAGNOSTICS TABLE (10 COLUMNS)
  if (masterSalesmenTbody) {
    if (cachedSalesmenBreakdown.length === 0) {
      masterSalesmenTbody.innerHTML = `
        <tr>
          <td colspan="10" class="py-8 text-center text-slate-400">
            No salesmen configured yet. Click "+ Add Salesman PIN" above to onboard your floor team.
          </td>
        </tr>
      `;
    } else {
      masterSalesmenTbody.innerHTML = cachedSalesmenBreakdown.map(sm => {
        const pinHidden = '••••';
        const sent = sm.sent || sm.totalOrders || 0;
        const viewed = sm.viewed || 0;
        const addressAdded = sm.addressAdded || 0;
        const settled = sm.paid || sm.paidOrders || 0;
        const rev = sm.revenue || 0;
        const convRate = sm.conversionRate || 0;
        const hasAccess = Boolean(sm.stockAccess);

        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <!-- 1: Salesman -->
            <td class="py-3 px-3.5 font-bold text-slate-900">
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-extrabold shrink-0">
                  ${escapeHtml(sm.name.substring(0, 2).toUpperCase())}
                </span>
                <span class="truncate">${escapeHtml(sm.name)}</span>
              </div>
            </td>
            <!-- 2: PIN -->
            <td class="py-3 px-3.5 font-mono font-bold text-slate-800">
              <span id="pinDisplay_${sm.id}" class="tracking-widest">${pinHidden}</span>
              <button type="button" onclick="togglePinReveal('${sm.id}', '${sm.pin}')" class="ml-2 text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer text-[12px]" title="Show/Hide PIN">
                <span class="material-symbols-outlined text-[15px] align-middle" id="pinIcon_${sm.id}">visibility</span>
              </button>
            </td>
            <!-- 3: Sent -->
            <td class="py-3 px-3.5 font-semibold text-slate-700 font-mono">
              ${sent}
            </td>
            <!-- 4: Viewed -->
            <td class="py-3 px-3.5 font-semibold text-blue-700 font-mono">
              ${viewed} <span class="text-[10px] text-slate-400">(${sent > 0 ? Math.round((viewed / sent) * 100) : 0}%)</span>
            </td>
            <!-- 5: Address -->
            <td class="py-3 px-3.5 font-semibold text-indigo-700 font-mono">
              ${addressAdded} <span class="text-[10px] text-slate-400">(${sent > 0 ? Math.round((addressAdded / sent) * 100) : 0}%)</span>
            </td>
            <!-- 6: Settled -->
            <td class="py-3 px-3.5 font-bold text-emerald-700 font-mono">
              ${settled}
            </td>
            <!-- 7: Total Revenue -->
            <td class="py-3 px-3.5 font-extrabold text-slate-900 font-mono">
              ₹${rev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <!-- 8: Conversion -->
            <td class="py-3 px-3.5">
              <span class="px-2 py-0.5 rounded-full ${convRate >= 50 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-200'} text-[11px] font-bold border">
                ${convRate}%
              </span>
            </td>
            <!-- 9: Stock CRM Access -->
            <td class="py-3 px-3.5">
              <button type="button" onclick="handleToggleStaffStockAccess('${sm.id}', ${!hasAccess})" class="px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors cursor-pointer inline-flex items-center gap-1.5 ${hasAccess ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'}" title="Toggle Stock CRM editing permission">
                <span class="w-1.5 h-1.5 rounded-full ${hasAccess ? 'bg-emerald-500' : 'bg-slate-400'}"></span>
                <span>${hasAccess ? 'Stock Access' : 'Enforced'}</span>
              </button>
            </td>
            <!-- 10: Actions -->
            <td class="py-3 px-3.5 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button type="button" onclick="openEditSalesmanModal('${sm.id}', '${escapeHtml(sm.name)}', '${sm.pin}', ${hasAccess})" class="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-[11px] font-bold transition-colors cursor-pointer">
                  Edit PIN
                </button>
                <button type="button" onclick="handleDeleteSalesman('${sm.id}', '${escapeHtml(sm.name)}')" class="p-1 hover:bg-rose-50 text-slate-300 hover:text-rose-600 rounded-lg transition-colors cursor-pointer" title="Remove Salesman">
                  <span class="material-symbols-outlined text-[16px]">delete</span>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    const salesmenMobileList = document.getElementById('masterSalesmenMobileList');
    if (salesmenMobileList) {
      if (cachedSalesmenBreakdown.length === 0) {
        salesmenMobileList.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs">No salesmen configured yet. Click "+ Add Salesman PIN" above to onboard team.</div>`;
      } else {
        salesmenMobileList.innerHTML = cachedSalesmenBreakdown.map(sm => {
          const sent = sm.sent || sm.totalOrders || 0;
          const settled = sm.paid || sm.paidOrders || 0;
          const rev = sm.revenue || 0;
          const convRate = sm.conversionRate || 0;
          const hasAccess = Boolean(sm.stockAccess);

          return `
            <div class="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-2xs flex flex-col gap-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <span class="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-extrabold shrink-0">
                    ${escapeHtml(sm.name.substring(0, 2).toUpperCase())}
                  </span>
                  <div>
                    <span class="font-extrabold text-slate-900 text-xs sm:text-sm block">${escapeHtml(sm.name)}</span>
                    <span class="font-mono text-[10px] text-slate-400">PIN: ••••</span>
                  </div>
                </div>
                <span class="px-2 py-0.5 rounded-full ${convRate >= 50 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-200'} text-[10px] font-bold border">
                  ${convRate}% Conv
                </span>
              </div>

              <!-- Stats Ribbon -->
              <div class="grid grid-cols-3 gap-2 py-2 border-y border-slate-100 text-center">
                <div>
                  <span class="text-[10px] text-slate-400 uppercase font-bold block">Sent</span>
                  <span class="font-mono font-bold text-xs text-slate-800">${sent}</span>
                </div>
                <div>
                  <span class="text-[10px] text-slate-400 uppercase font-bold block">Settled</span>
                  <span class="font-mono font-bold text-xs text-emerald-600">${settled}</span>
                </div>
                <div>
                  <span class="text-[10px] text-slate-400 uppercase font-bold block">Revenue</span>
                  <span class="font-mono font-bold text-xs text-slate-900">₹${rev.toLocaleString('en-IN')}</span>
                </div>
              </div>

              <!-- Controls -->
              <div class="flex items-center justify-between pt-0.5">
                <button type="button" onclick="handleToggleStaffStockAccess('${sm.id}', ${!hasAccess})" class="px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors cursor-pointer inline-flex items-center gap-1.5 ${hasAccess ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}">
                  <span class="w-1.5 h-1.5 rounded-full ${hasAccess ? 'bg-emerald-500' : 'bg-slate-400'}"></span>
                  <span>${hasAccess ? 'Stock Access: ON' : 'Stock Access: OFF'}</span>
                </button>
                <div class="flex items-center gap-1.5">
                  <button type="button" onclick="openEditSalesmanModal('${sm.id}', '${escapeHtml(sm.name)}', '${sm.pin}', ${hasAccess})" class="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-bold transition-colors">
                    Edit PIN
                  </button>
                  <button type="button" onclick="handleDeleteSalesman('${sm.id}', '${escapeHtml(sm.name)}')" class="p-1 hover:bg-rose-50 text-slate-300 hover:text-rose-600 rounded-lg transition-colors">
                    <span class="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }
}

// 2. Render Master Orders & Dispatch Board (Authoritative Unified Orders Board)
window.orderSearchQuery = '';
window.handleOrderSearch = function(query) {
  window.orderSearchQuery = (query || '').trim().toLowerCase();
  renderMasterDispatchTable();
};

window.markCockpitOrderPaid = async function() {
  if (currentRole !== 'OWNER') {
    showToast('⚠️ Only Store Owners can confirm payment manually.');
    return;
  }
  const target = activeOrder || (cachedOrders && cachedOrders.find(o => o.status === 'PENDING')) || null;
  if (!target) {
    showToast('⚠️ No active order found to confirm.');
    return;
  }
  await window.manualMarkPaid(target.ref);
};

window.manualMarkPaid = async function(ref) {
  if (currentRole !== 'OWNER') {
    showToast('⚠️ Access denied: Only Store Owners can confirm payments.');
    return;
  }
  if (!confirm(`Confirm and mark Order #REF-${ref} as PAID manually?\nThis verifies customer settlement, protects stock, and marks order ready for express dispatch.`)) return;
  try {
    showToast(`⏳ Confirming payment for #REF-${ref}...`);
    const res = await fetch(`/api/orders/${ref}/mark-paid`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ paymentMethod: 'Manual Owner Verification / Direct UPI' })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Order #REF-${ref} confirmed & marked PAID!`);
      playCashChime();
      await fetchOrdersAndMetrics();
      if (data.order) {
        if (activeOrder && (activeOrder.ref === ref || activeOrder.token === ref)) {
          activeOrder = data.order;
        }
        renderCockpit(data.order);
      }
      renderMasterDispatchTable();
    } else {
      showToast(`⚠️ ${data.error || 'Failed to mark order paid'}`);
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Network error marking paid');
  }
};

function renderMasterDispatchTable() {
  const dispSalesmanFilter = document.getElementById('dispSalesmanFilter');
  const dispSalesmanFilterWrapper = document.getElementById('dispSalesmanFilterWrapper');
  const masterDispatchTbody = document.getElementById('masterDispatchTbody');
  const ordersBoardHeading = document.getElementById('ordersBoardHeading');

  // Role Scoping for UI Headers
  if (currentRole === 'SALESMAN') {
    if (ordersBoardHeading) ordersBoardHeading.textContent = 'My Orders & Dispatch Board';
    if (dispSalesmanFilterWrapper) dispSalesmanFilterWrapper.classList.add('hidden');
  } else {
    if (ordersBoardHeading) ordersBoardHeading.textContent = 'Orders & Dispatch Board';
    if (dispSalesmanFilterWrapper) dispSalesmanFilterWrapper.classList.remove('hidden');
  }

  // Top Metrics Aggregation
  const pendingCount = cachedOrders.filter(o => o.status !== 'PAID').length;
  const packedCount = cachedOrders.filter(o => o.status === 'PAID' && (o.dispatchStatus === 'PACKING' || o.dispatchStatus === 'PACKED')).length;
  const shippedCount = cachedOrders.filter(o => o.status === 'PAID' && o.dispatchStatus === 'DISPATCHED').length;
  const deliveredCount = cachedOrders.filter(o => o.status === 'PAID' && o.dispatchStatus === 'DELIVERED').length;

  const elPending = document.getElementById('dispMetricPending');
  const elPacked = document.getElementById('dispMetricPacked');
  const elShipped = document.getElementById('dispMetricShipped');
  const elDelivered = document.getElementById('dispMetricDelivered');

  if (elPending) elPending.textContent = `${pendingCount} Orders`;
  if (elPacked) elPacked.textContent = `${packedCount} Orders`;
  if (elShipped) elShipped.textContent = `${shippedCount} Orders`;
  if (elDelivered) elDelivered.textContent = `${deliveredCount} Orders`;

  // Populate Salesman Filter Dropdown (Owner Only)
  if (dispSalesmanFilter && currentRole === 'OWNER') {
    const currentVal = dispSalesmanFilter.value;
    dispSalesmanFilter.innerHTML = `
      <option value="ALL">All Staff</option>
      ${cachedSalesmenBreakdown.map(sm => `
        <option value="${sm.id}">${escapeHtml(sm.name)}</option>
      `).join('')}
    `;
    if (currentVal && cachedSalesmenBreakdown.some(sm => sm.id === currentVal)) {
      dispSalesmanFilter.value = currentVal;
    }
  }

  if (!masterDispatchTbody) return;

  let list = [...cachedOrders];

  // Apply Salesman Filter (Owner only)
  if (currentRole === 'OWNER' && dispFilterSalesman !== 'ALL') {
    list = list.filter(o => o.salesmanId === dispFilterSalesman);
  }

  // Apply Status Filter
  if (dispFilterStatus !== 'ALL') {
    if (dispFilterStatus === 'PENDING') {
      list = list.filter(o => o.status !== 'PAID');
    } else if (dispFilterStatus === 'PAID') {
      list = list.filter(o => o.status === 'PAID');
    } else if (dispFilterStatus === 'PACKING') {
      list = list.filter(o => o.status === 'PAID' && (o.dispatchStatus === 'PACKING' || o.dispatchStatus === 'PACKED'));
    } else if (dispFilterStatus === 'DISPATCHED') {
      list = list.filter(o => o.status === 'PAID' && o.dispatchStatus === 'DISPATCHED');
    } else if (dispFilterStatus === 'DELIVERED') {
      list = list.filter(o => o.status === 'PAID' && o.dispatchStatus === 'DELIVERED');
    }
  }

  // Apply Live Instant Search
  const searchInput = document.getElementById('orderSearchInput');
  const query = (searchInput?.value || window.orderSearchQuery || '').trim().toLowerCase();
  if (query) {
    list = list.filter(o => {
      const refMatch = String(o.ref || '').toLowerCase().includes(query);
      const nameMatch = String(o.customerName || '').toLowerCase().includes(query);
      const phoneMatch = String(o.customerPhone || '').toLowerCase().includes(query);
      const descMatch = String(o.itemDescription || '').toLowerCase().includes(query);
      const skuMatch = String(o.sku || '').toLowerCase().includes(query);
      const trkMatch = String(o.trackingNumber || '').toLowerCase().includes(query);
      const utrMatch = String(o.utr || '').toLowerCase().includes(query);
      const smMatch = String(o.salesmanName || '').toLowerCase().includes(query);
      return refMatch || nameMatch || phoneMatch || descMatch || skuMatch || trkMatch || utrMatch || smMatch;
    });
  }

  const masterDispatchMobileList = document.getElementById('masterDispatchMobileList');

  if (list.length === 0) {
    const emptyHtml = `
      <div class="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-slate-400">
        <span class="material-symbols-outlined text-[32px] text-slate-300">receipt_long</span>
        <span class="font-semibold text-xs text-slate-500">No orders match the current filter or search criteria.</span>
        <span class="text-[11px] text-slate-400">Orders created via New Sale will appear here instantly in real-time.</span>
      </div>
    `;
    if (masterDispatchTbody) masterDispatchTbody.innerHTML = `<tr><td colspan="9" class="p-0">${emptyHtml}</td></tr>`;
    if (masterDispatchMobileList) masterDispatchMobileList.innerHTML = emptyHtml;
    return;
  }

  // 1. Desktop Authoritative Table Rows (9 Columns)
  if (masterDispatchTbody) {
    masterDispatchTbody.innerHTML = list.map(order => {
      const isPaid = order.status === 'PAID';
      const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);
      const dispStatus = order.dispatchStatus || 'PENDING';

      // Format Doorstep Address
      let addressHtml = '';
      if (order.address) {
        const a = order.address;
        addressHtml = `
          <div class="flex flex-col text-[11px] leading-tight max-w-[260px]">
            <span class="font-bold text-slate-900 truncate">${escapeHtml(a.fullName || order.customerName)}</span>
            <span class="text-slate-600 mt-0.5 truncate">${escapeHtml(a.flat)}, ${escapeHtml(a.street || '')}</span>
            <span class="text-slate-500 font-semibold truncate">${escapeHtml(a.city)}, ${escapeHtml(a.state)} - <strong class="text-slate-900 font-mono">${escapeHtml(a.pincode)}</strong></span>
          </div>
        `;
      } else {
        addressHtml = `<span class="text-slate-400 italic text-[11px]">Awaiting entry on checkout</span>`;
      }

      // Journey & Payment Badge
      let journeyHtml = '';
      if (isPaid) {
        journeyHtml = `
          <div class="flex flex-col gap-0.5">
            <span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold inline-flex items-center gap-1 w-max">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> PAID
            </span>
            <span class="font-mono text-[10px] text-slate-500 font-bold truncate max-w-[130px]" title="${order.utr || 'Bank Verified'}">
              UTR: ${escapeHtml(order.utr || 'Auto')}
            </span>
          </div>
        `;
      } else {
        const isPayStarted = order.steps && order.steps.redirectedToPayment && order.steps.redirectedToPayment.done;
        const hasAddr = order.address || (order.steps && order.steps.addressEntered && order.steps.addressEntered.done);
        const isOpened = order.steps && order.steps.opened && order.steps.opened.done;

        if (isPayStarted) {
          journeyHtml = `
            <span class="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold inline-flex items-center gap-1 w-max">
              <span class="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span> In Payment App
            </span>
          `;
        } else if (hasAddr) {
          journeyHtml = `
            <span class="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold inline-flex items-center gap-1 w-max">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-500"></span> Address Added
            </span>
          `;
        } else if (isOpened) {
          journeyHtml = `
            <span class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold inline-flex items-center gap-1 w-max">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Link Opened
            </span>
          `;
        } else {
          journeyHtml = `
            <span class="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold inline-flex items-center gap-1 w-max">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Link Sent
            </span>
          `;
        }
      }

      // Fulfillment Status Control
      let fulfillmentHtml = '';
      if (isPaid) {
        fulfillmentHtml = `
          <select onchange="updateDispatchStatus('${order.ref}', this.value)" class="text-xs font-bold rounded-xl px-2.5 py-1.5 border outline-none cursor-pointer ${
            dispStatus === 'DELIVERED' ? 'bg-emerald-50 text-emerald-800 border-emerald-300' :
            dispStatus === 'DISPATCHED' ? 'bg-blue-50 text-blue-800 border-blue-300' :
            dispStatus === 'PACKING' || dispStatus === 'PACKED' ? 'bg-indigo-50 text-indigo-800 border-indigo-300' :
            'bg-amber-50 text-amber-800 border-amber-300'
          }">
            <option value="PENDING" ${dispStatus === 'PENDING' ? 'selected' : ''}>⏳ Pending</option>
            <option value="PACKING" ${dispStatus === 'PACKING' || dispStatus === 'PACKED' ? 'selected' : ''}>📦 Packing</option>
            <option value="DISPATCHED" ${dispStatus === 'DISPATCHED' ? 'selected' : ''}>🚚 Dispatched</option>
            <option value="DELIVERED" ${dispStatus === 'DELIVERED' ? 'selected' : ''}>✅ Delivered</option>
          </select>
        `;
      } else {
        fulfillmentHtml = `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold text-[10px]">Awaiting Payment</span>`;
      }

      // Tracking AWB Input
      let trackingHtml = '';
      if (isPaid) {
        trackingHtml = `
          <div class="flex items-center gap-1.5">
            <input 
              id="trk_${order.ref}" 
              type="text" 
              placeholder="e.g. AWB109283" 
              value="${escapeHtml(order.trackingNumber || '')}" 
              class="w-28 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono font-semibold outline-none focus:border-indigo-500" 
            />
            <button 
              type="button" 
              onclick="saveTrackingNumber('${order.ref}')" 
              class="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[10px] font-bold cursor-pointer" 
              title="Save Tracking Number">
              ✓
            </button>
          </div>
        `;
      } else {
        trackingHtml = `<span class="text-slate-400 font-mono text-[10px]">—</span>`;
      }

      // WhatsApp Nudge link for pending orders
      const origin = window.location.origin;
      const payUrl = `${origin}/pay?token=${order.token || order.ref}`;
      const nudgeMsg = encodeURIComponent(`Hi ${order.customerName || 'there'}, your reservation for "${order.itemDescription}" (₹${payableAmt}) is reserved. Complete your order here: ${payUrl}`);
      const waNudgeUrl = order.customerPhone ? `https://wa.me/91${order.customerPhone}?text=${nudgeMsg}` : '#';

      return `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <!-- Ref # -->
          <td class="py-3 px-3.5 font-mono font-bold text-indigo-600 whitespace-nowrap">
            #REF-${order.ref}
          </td>

          <!-- Staff -->
          <td class="py-3 px-3.5 whitespace-nowrap">
            <span class="px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200/90 text-indigo-700 font-bold text-xs inline-flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-indigo-600"></span>
              <span>${escapeHtml(order.salesmanName || 'Store Desk')}</span>
            </span>
          </td>

          <!-- Customer & Contact -->
          <td class="py-3 px-3.5 whitespace-nowrap">
            <span class="font-bold text-slate-900 block">${escapeHtml(order.customerName)}</span>
            ${order.customerPhone ? `
              <a href="https://wa.me/91${order.customerPhone}" target="_blank" class="text-[11px] text-emerald-700 font-mono font-semibold flex items-center gap-1 hover:underline">
                <span class="material-symbols-outlined text-[13px]">chat</span>
                <span>+91 ${escapeHtml(order.customerPhone)}</span>
              </a>
            ` : '<span class="text-slate-400 font-mono text-[10px]">—</span>'}
          </td>

          <!-- Item & Amount -->
          <td class="py-3 px-3.5 max-w-xs">
            <div class="truncate text-slate-800 font-medium">
              ${order.sku ? `<span class="font-mono text-indigo-600 font-bold text-[10px] mr-1">#${escapeHtml(order.sku)}</span>` : ''}
              ${escapeHtml(order.itemDescription)}
            </div>
            <div class="font-mono font-extrabold text-slate-900 text-xs mt-0.5">
              ₹${payableAmt}
            </div>
          </td>

          <!-- Journey & Payment -->
          <td class="py-3 px-3.5 whitespace-nowrap">
            ${journeyHtml}
          </td>

          <!-- Doorstep Shipping Address -->
          <td class="py-3 px-3.5">
            ${addressHtml}
          </td>

          <!-- Fulfillment Status Dropdown -->
          <td class="py-3 px-3.5 whitespace-nowrap">
            ${fulfillmentHtml}
          </td>

          <!-- Tracking Number -->
          <td class="py-3 px-3.5 whitespace-nowrap">
            ${trackingHtml}
          </td>

          <!-- Actions -->
          <td class="py-3 px-3.5 text-right whitespace-nowrap">
            <div class="flex items-center justify-end gap-1.5">
              <button type="button" onclick="activateTab('${order.ref}')" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-bold transition-colors cursor-pointer" title="Open 5-Step Radar">
                Radar
              </button>
              ${currentRole === 'OWNER' && !isPaid ? `
                <button type="button" onclick="manualMarkPaid('${order.ref}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold transition-colors cursor-pointer" title="Manually verify & mark PAID">
                  Mark Paid
                </button>
              ` : ''}
              ${!isPaid && order.customerPhone ? `
                <a href="${waNudgeUrl}" target="_blank" class="p-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors" title="Send WhatsApp Nudge">
                  <span class="material-symbols-outlined text-[16px]">send</span>
                </a>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 2. Mobile Cards Feed (Touch-Optimized for Phones)
  if (masterDispatchMobileList) {
    masterDispatchMobileList.innerHTML = list.map(order => {
      const isPaid = order.status === 'PAID';
      const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);
      const dispStatus = order.dispatchStatus || 'PENDING';

      const origin = window.location.origin;
      const payUrl = `${origin}/pay?token=${order.token || order.ref}`;
      const nudgeMsg = encodeURIComponent(`Hi ${order.customerName || 'there'}, your reservation for "${order.itemDescription}" (₹${payableAmt}) is reserved. Complete your order here: ${payUrl}`);
      const waNudgeUrl = order.customerPhone ? `https://wa.me/91${order.customerPhone}?text=${nudgeMsg}` : '#';

      const trkMsg = encodeURIComponent(`Hi ${order.customerName || 'there'}, your order #REF-${order.ref} for "${order.itemDescription}" has been dispatched via courier! Tracking AWB: ${order.trackingNumber || 'En route'}. Live tracking: ${payUrl}`);
      const waTrkUrl = order.customerPhone ? `https://wa.me/91${order.customerPhone}?text=${trkMsg}` : '#';

      return `
        <div class="bg-white rounded-2xl border border-slate-200/90 p-4 shadow-2xs flex flex-col gap-3">
          <!-- Top row: Ref, Staff, Status -->
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="font-mono font-extrabold text-xs text-indigo-600">#REF-${order.ref}</span>
              <span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-[10px] font-bold">${escapeHtml(order.salesmanName || 'Staff Desk')}</span>
            </div>
            ${isPaid ? `
              <select onchange="updateDispatchStatus('${order.ref}', this.value)" class="text-xs font-bold rounded-xl px-2.5 py-1 border outline-none cursor-pointer ${
                dispStatus === 'DELIVERED' ? 'bg-emerald-50 text-emerald-800 border-emerald-300' :
                dispStatus === 'DISPATCHED' ? 'bg-blue-50 text-blue-800 border-blue-300' :
                dispStatus === 'PACKING' || dispStatus === 'PACKED' ? 'bg-indigo-50 text-indigo-800 border-indigo-300' :
                'bg-amber-50 text-amber-800 border-amber-300'
              }">
                <option value="PENDING" ${dispStatus === 'PENDING' ? 'selected' : ''}>⏳ Pending</option>
                <option value="PACKING" ${dispStatus === 'PACKING' || dispStatus === 'PACKED' ? 'selected' : ''}>📦 Packing</option>
                <option value="DISPATCHED" ${dispStatus === 'DISPATCHED' ? 'selected' : ''}>🚚 Dispatched</option>
                <option value="DELIVERED" ${dispStatus === 'DELIVERED' ? 'selected' : ''}>✅ Delivered</option>
              </select>
            ` : `
              <span class="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-200">
                Awaiting Payment
              </span>
            `}
          </div>

          <!-- Item & Price -->
          <div class="flex items-center justify-between py-1.5 border-y border-slate-100 text-xs">
            <div class="min-w-0 pr-2">
              <div class="font-extrabold text-slate-900 truncate">${escapeHtml(order.itemDescription)}</div>
              <div class="text-[10px] text-slate-400 font-mono">${isPaid ? `UTR: ${escapeHtml(order.utr || 'Auto')}` : 'Step: Pending Payment'}</div>
            </div>
            <div class="font-mono font-extrabold text-slate-900 text-sm shrink-0">
              ₹${payableAmt}
            </div>
          </div>

          <!-- Customer & Doorstep Address -->
          <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-200/60 text-xs flex flex-col gap-1">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 truncate">${escapeHtml(order.customerName)}</span>
              ${order.customerPhone ? `
                <div class="flex items-center gap-1.5 shrink-0">
                  <a href="tel:+91${order.customerPhone}" class="w-7 h-7 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 flex items-center justify-center transition-colors active:scale-95" title="Call Customer">
                    <span class="material-symbols-outlined text-[15px]">call</span>
                  </a>
                  <a href="https://wa.me/91${order.customerPhone}" target="_blank" class="w-7 h-7 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-600 flex items-center justify-center transition-colors active:scale-95" title="WhatsApp Chat">
                    <span class="material-symbols-outlined text-[15px]">chat</span>
                  </a>
                </div>
              ` : ''}
            </div>
            ${order.address ? `
              <div class="text-[11px] text-slate-600 leading-tight mt-0.5">
                ${escapeHtml(order.address.flat)}, ${escapeHtml(order.address.street || '')}, ${escapeHtml(order.address.city)}, ${escapeHtml(order.address.state)} - <strong class="font-mono text-slate-900">${escapeHtml(order.address.pincode)}</strong>
              </div>
            ` : `<span class="text-slate-400 italic text-[11px]">No doorstep address provided yet</span>`}
          </div>

          <!-- Actions & Tracking -->
          <div class="flex items-center justify-between gap-1.5 pt-1 flex-wrap">
            <div class="flex items-center gap-1.5">
              <button type="button" onclick="activateTab('${order.ref}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 rounded-xl text-xs font-bold transition-all">
                Radar
              </button>
              <button type="button" onclick="shareOrderLinkMobile('${order.ref}', '${payUrl}', '${escapeHtml(order.itemDescription).replace(/'/g, "\\'")}', '${payableAmt}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1 transition-all" title="Share via WhatsApp or Apps">
                <span class="material-symbols-outlined text-[14px]">share</span>
                <span>Share</span>
              </button>
            </div>

            ${currentRole === 'OWNER' && !isPaid ? `
              <button type="button" onclick="manualMarkPaid('${order.ref}')" class="px-3 py-1.5 bg-emerald-600 active:scale-95 text-white rounded-xl text-xs font-bold">
                Mark Paid
              </button>
            ` : ''}

            ${!isPaid && order.customerPhone ? `
              <a href="${waNudgeUrl}" target="_blank" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 active:scale-95 rounded-xl text-xs font-bold no-underline flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">send</span>
                <span>Nudge WA</span>
              </a>
            ` : ''}

            ${isPaid ? `
              <div class="flex items-center gap-1 flex-1 justify-end flex-wrap">
                <input 
                  id="mob_trk_${order.ref}" 
                  type="text" 
                  placeholder="AWB #" 
                  value="${escapeHtml(order.trackingNumber || '')}" 
                  class="w-20 bg-white border border-slate-200 rounded-xl px-2 py-1 text-xs outline-none focus:border-indigo-500 font-mono" 
                />
                <button 
                  type="button" 
                  onclick="saveTrackingNumberMobile('${order.ref}')" 
                  class="px-2.5 py-1 bg-slate-900 active:scale-95 text-white rounded-xl text-xs font-bold cursor-pointer shrink-0">
                  Save
                </button>
                ${order.customerPhone ? `
                  <a href="${waTrkUrl}" target="_blank" class="px-2 py-1 bg-emerald-600 active:scale-95 text-white rounded-xl text-xs font-bold flex items-center gap-1 no-underline" title="Send WhatsApp Tracking Update">
                    <span class="material-symbols-outlined text-[14px]">local_shipping</span>
                  </a>
                ` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }
}

window.saveTrackingNumberMobile = function(ref) {
  const input = document.getElementById(`mob_trk_${ref}`);
  if (!input) return;
  const desktopInput = document.getElementById(`trk_${ref}`);
  if (desktopInput) desktopInput.value = input.value;
  saveTrackingNumber(ref);
};

// Update Dispatch Status via API
async function updateDispatchStatus(ref, newStatus) {
  try {
    const res = await fetch(`/api/orders/${ref}/dispatch`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`📦 Order #${ref} status updated to ${newStatus}`);
      await fetchOrdersAndMetrics();
      renderMasterDispatchTable();
    } else {
      showToast('⚠️ Failed to update status');
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  }
}

// Save Tracking Number via API
async function saveTrackingNumber(ref) {
  const input = document.getElementById(`trk_${ref}`);
  if (!input) return;
  const trackingNumber = input.value.trim();

  try {
    const res = await fetch(`/api/orders/${ref}/dispatch`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ trackingNumber })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🚚 Tracking number saved for Order #${ref}!`);
      await fetchOrdersAndMetrics();
      renderMasterDispatchTable();
    } else {
      showToast('⚠️ Failed to save tracking number');
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  }
}

function handleDispatchSalesmanFilter(val) {
  dispFilterSalesman = val;
  renderMasterDispatchTable();
}

function filterDispatchStatus(status, btn) {
  dispFilterStatus = status;
  document.querySelectorAll('.disp-filter-btn').forEach(b => {
    b.className = 'disp-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer';
  });
  if (btn) btn.className = 'disp-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-slate-900 text-white shadow-xs cursor-pointer';
  renderMasterDispatchTable();
}

// 3. Store Settings Engine & Sub-Tabs Controller (Owner Exclusive)
let currentSettingsTab = 'profile';

window.setSettingsTab = function(tabName) {
  currentSettingsTab = tabName;

  const profileSection = document.getElementById('setSectionProfile');
  const teamSection = document.getElementById('setSectionTeam');
  const bankingSection = document.getElementById('setSectionBanking');

  const tabBtnProfile = document.getElementById('setTabBtnProfile');
  const tabBtnTeam = document.getElementById('setTabBtnTeam');
  const tabBtnBanking = document.getElementById('setTabBtnBanking');

  const activeClass = 'px-3.5 py-1.5 rounded-xl bg-white text-indigo-700 shadow-2xs font-bold border border-slate-200/80 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap';
  const inactiveClass = 'px-3.5 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-white/70 transition-colors cursor-pointer font-semibold flex items-center gap-1.5 whitespace-nowrap';

  if (profileSection) profileSection.classList.toggle('hidden', tabName !== 'profile');
  if (teamSection) teamSection.classList.toggle('hidden', tabName !== 'team');
  if (bankingSection) bankingSection.classList.toggle('hidden', tabName !== 'banking');

  if (tabBtnProfile) tabBtnProfile.className = tabName === 'profile' ? activeClass : inactiveClass;
  if (tabBtnTeam) tabBtnTeam.className = tabName === 'team' ? activeClass : inactiveClass;
  if (tabBtnBanking) tabBtnBanking.className = tabName === 'banking' ? activeClass : inactiveClass;

  if (tabName === 'team') {
    renderMasterDashboard();
  }
};

async function loadStoreSettings(showToastOnSuccess = false) {
  if (currentRole !== 'OWNER') return;

  // Protect active user input from being overwritten while typing
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.id === 'setVerifiedSenderEmail' || activeEl.closest('#viewStoreSettings'))) {
    return;
  }

  try {
    const res = await fetch('/api/store/settings', {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    const s = data.settings || {};

    const setBrandName = document.getElementById('setBrandName');
    const setOwnerName = document.getElementById('setOwnerName');
    const setCategory = document.getElementById('setCategory');
    const setPhone = document.getElementById('setPhone');
    const setUpiId = document.getElementById('setUpiId');
    const setStoreLocation = document.getElementById('setStoreLocation');
    const setStoreInstagram = document.getElementById('setStoreInstagram');
    const setAssuranceText = document.getElementById('setAssuranceText');
    const setLogoData = document.getElementById('setLogoData');
    const setLogoUrl = document.getElementById('setLogoUrl');
    const setLogoImgPreview = document.getElementById('setLogoImgPreview');
    const setLogoFallbackIcon = document.getElementById('setLogoFallbackIcon');
    const btnRemoveLogo = document.getElementById('btnRemoveLogo');

    if (setBrandName) setBrandName.value = s.brandName || '';
    if (setOwnerName) setOwnerName.value = s.ownerName || '';
    if (setCategory) setCategory.value = s.brandCategory || 'Luxury Pret & Festive';
    if (setPhone) setPhone.value = s.phone || '';
    if (setUpiId) setUpiId.value = s.upiId || '';
    if (setStoreLocation) setStoreLocation.value = s.storeLocation || '';
    if (setStoreInstagram) setStoreInstagram.value = s.storeInstagram || '';
    if (setAssuranceText) setAssuranceText.value = s.assuranceText || 'Your item is handcrafted and reserved exclusively for you.';

    if (s.storeLogo) {
      if (setLogoData) setLogoData.value = s.storeLogo;
      if (setLogoImgPreview) {
        setLogoImgPreview.src = s.storeLogo;
        setLogoImgPreview.classList.remove('hidden');
      }
      if (setLogoFallbackIcon) setLogoFallbackIcon.classList.add('hidden');
      if (btnRemoveLogo) btnRemoveLogo.classList.remove('hidden');
      if (setLogoUrl && s.storeLogo.startsWith('http')) setLogoUrl.value = s.storeLogo;
    } else {
      clearStoreLogo();
    }

    updateSettingsPreview();

    // Bank Credit Email Automation Population
    const ba = s.bankingAutomation || {};
    const setBankCode = document.getElementById('setBankCode');
    const setVerifiedSenderEmail = document.getElementById('setVerifiedSenderEmail');
    const setBankImapUser = document.getElementById('setBankImapUser');
    const setBankImapPassword = document.getElementById('setBankImapPassword');
    const setBankMonitoringActive = document.getElementById('setBankMonitoringActive');
    const monitoringActiveLabel = document.getElementById('monitoringActiveLabel');
    const bankStatusDot = document.getElementById('bankStatusDot');
    const bankStatusText = document.getElementById('bankStatusText');
    const bankLastCheckedText = document.getElementById('bankLastCheckedText');

    if (setBankCode) setBankCode.value = ba.bankCode || 'ICICI';
    if (setVerifiedSenderEmail) setVerifiedSenderEmail.value = ba.verifiedSenderEmail || (BANK_PRESET_SENDERS[ba.bankCode || 'ICICI'] || 'bankingalerts@icicibank.com');
    if (setBankImapUser) setBankImapUser.value = ba.imapUser || s.email || '';
    if (setBankImapPassword) {
      setBankImapPassword.value = '';
      if (ba.hasAppPassword) {
        setBankImapPassword.placeholder = '•••••••••••••••• (Saved - leave blank to keep current)';
      } else {
        setBankImapPassword.placeholder = 'e.g. abcd efgh ijkl mnop';
      }
    }
    // Google OAuth 1-Click State
    const googleNotConnectedState = document.getElementById('googleNotConnectedState');
    const googleConnectedState = document.getElementById('googleConnectedState');
    const googleConnectedEmail = document.getElementById('googleConnectedEmail');
    const googleLastPollText = document.getElementById('googleLastPollText');
    const isGoogleConnected = Boolean(ba.googleOAuth && ba.googleOAuth.connected);

    if (isGoogleConnected) {
      if (googleNotConnectedState) googleNotConnectedState.classList.add('hidden');
      if (googleConnectedState) googleConnectedState.classList.remove('hidden');
      if (googleConnectedEmail) googleConnectedEmail.textContent = ba.googleOAuth.connectedEmail || s.email || 'connected@gmail.com';
      if (googleLastPollText) {
        googleLastPollText.textContent = ba.lastCheckedAt 
          ? `Last checked: ${new Date(ba.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} • Auto-polling official Gmail API`
          : 'Auto-detecting bank alerts in real time via official Google Gmail API';
      }
    } else {
      if (googleNotConnectedState) googleNotConnectedState.classList.remove('hidden');
      if (googleConnectedState) googleConnectedState.classList.add('hidden');
    }

    if (bankStatusDot && bankStatusText) {
      if (isGoogleConnected) {
        bankStatusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0';
        bankStatusText.textContent = `1-Click Gmail auto-detection active (${ba.bankName || ba.bankCode || 'ICICI'})`;
        if (bankLastCheckedText) {
          bankLastCheckedText.textContent = ba.lastCheckedAt 
            ? `Last poll: ${new Date(ba.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` 
            : 'Polling Gmail API every 20s';
        }
      } else {
        bankStatusDot.className = 'w-2.5 h-2.5 rounded-full bg-slate-300 shrink-0';
        bankStatusText.textContent = 'Auto-detection on standby';
        if (bankLastCheckedText) {
          bankLastCheckedText.textContent = 'Click "Connect with Google" to activate seamless detection';
        }
      }
    }

    if (typeof onBankSelectChange === 'function') {
      onBankSelectChange(false);
    }

    // Check query params for Google OAuth redirect status
    if (window.location.search.includes('google_connected=success')) {
      showToast('🎉 Gmail connected successfully! Bank credit emails will auto-settle.');
      history.replaceState(null, '', window.location.pathname + '?tab=settings');
    } else if (window.location.search.includes('google_error=')) {
      const err = new URLSearchParams(window.location.search).get('google_error');
      showToast('⚠️ Google login error: ' + (err || 'Unknown error'));
      history.replaceState(null, '', window.location.pathname + '?tab=settings');
    }

    if (showToastOnSuccess) {
      showToast('⚙️ Store settings loaded');
    }
  } catch (err) {
    console.error(err);
  }
}

// Google OAuth 1-Click Connection Handlers
async function connectGoogleOAuth() {
  const btn = document.getElementById('btnConnectGoogle');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span><span>Connecting...</span>`;
  }

  try {
    const res = await fetch('/api/auth/google/connect', {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (res.ok && data.success && data.authUrl) {
      showToast('🚀 Redirecting to Google Login...');
      window.location.href = data.authUrl;
    } else if (data.notConfigured) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
      openOAuthConfigModal(data.redirectUri);
      showToast('ℹ️ Please configure Google Cloud OAuth keys for your platform first.');
    } else {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
      showToast('⚠️ ' + (data.error || 'Failed to initiate Google sign-in'));
    }
  } catch (err) {
    console.error(err);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    showToast('⚠️ Network error connecting to Google');
  }
}

async function disconnectGoogleOAuth() {
  if (!confirm('Are you sure you want to disconnect your Gmail account from PaySap? Automated bank email detection will be paused.')) {
    return;
  }

  try {
    showToast('Disconnecting Google account...');
    const res = await fetch('/api/auth/google/disconnect', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('🔌 Google account disconnected successfully.');
      await loadStoreSettings(false);
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to disconnect account'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Failed to disconnect Google account');
  }
}

async function openOAuthConfigModal(defaultUri) {
  const modal = document.getElementById('modalOAuthConfig');
  const uriDisplay = document.getElementById('oauthRedirectUriDisplay');
  const clientIdInput = document.getElementById('oauthClientId');

  if (modal) {
    modal.classList.remove('hidden');
  }

  const fallbackUri = `${window.location.origin}/api/auth/google/callback`;
  if (uriDisplay) {
    uriDisplay.textContent = defaultUri || fallbackUri;
  }

  try {
    const res = await fetch('/api/admin/oauth-config', {
      headers: getAuthHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (uriDisplay && data.redirectUri) {
        uriDisplay.textContent = data.redirectUri;
      }
      if (clientIdInput && data.clientId) {
        clientIdInput.placeholder = data.clientId;
      }
    }
  } catch (e) {
    console.warn('Could not prefill oauth config:', e);
  }
}

function closeOAuthConfigModal() {
  const modal = document.getElementById('modalOAuthConfig');
  if (modal) modal.classList.add('hidden');
}

function copyOauthRedirectUri() {
  const uriDisplay = document.getElementById('oauthRedirectUriDisplay');
  if (!uriDisplay) return;
  const text = uriDisplay.textContent.trim();
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Redirect URI copied to clipboard!');
  }).catch(() => {
    showToast('⚠️ Could not copy automatically. Please select and copy.');
  });
}

async function savePlatformOAuthConfig() {
  const clientId = document.getElementById('oauthClientId')?.value?.trim();
  const clientSecret = document.getElementById('oauthClientSecret')?.value?.trim();
  const btn = document.getElementById('btnSaveOAuthConfig');

  if (!clientId || !clientSecret) {
    showToast('⚠️ Please enter both Client ID and Client Secret');
    return;
  }

  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span><span>Saving...</span>`;
  }

  try {
    const res = await fetch('/api/admin/oauth-config', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId, clientSecret })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ Google OAuth credentials saved! Store owners can now 1-click connect.');
      closeOAuthConfigModal();
      const idInput = document.getElementById('oauthClientId');
      const secInput = document.getElementById('oauthClientSecret');
      if (idInput) idInput.value = '';
      if (secInput) secInput.value = '';
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to save Google credentials'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Error saving credentials');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

// Image compression helper using HTML5 Canvas (Accepts any image format and resolution, optimizes for fast loading)
function compressImageFile(file, maxWidth = 500, maxHeight = 500, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected'));
    if (!file.type || !file.type.startsWith('image/')) {
      return reject(new Error('Please select a valid image file (PNG, JPG, SVG, WebP).'));
    }

    if (file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(mime, quality));
      };
      img.onerror = () => reject(new Error('Failed to decode image file.'));
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Logo upload, dropzone, and preview handlers
window.handleLogoDrop = function(event) {
  const dt = event.dataTransfer;
  const files = dt && dt.files;
  if (files && files.length > 0) {
    handleLogoFileSelect({ target: { files: [files[0]] } });
  }
};

window.handleLogoFileSelect = async function(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const feedback = document.getElementById('logoUploadFeedback');
  const feedbackText = document.getElementById('logoUploadFeedbackText');

  try {
    showToast('⏳ Processing logo image...');
    const dataUrl = await compressImageFile(file, 400, 400, 0.88);

    const setLogoData = document.getElementById('setLogoData');
    const setLogoImgPreview = document.getElementById('setLogoImgPreview');
    const setLogoFallbackIcon = document.getElementById('setLogoFallbackIcon');
    const btnRemoveLogo = document.getElementById('btnRemoveLogo');
    const setLogoUrl = document.getElementById('setLogoUrl');

    if (setLogoData) setLogoData.value = dataUrl;
    if (setLogoUrl) setLogoUrl.value = '';
    if (setLogoImgPreview) {
      setLogoImgPreview.src = dataUrl;
      setLogoImgPreview.classList.remove('hidden');
    }
    if (setLogoFallbackIcon) setLogoFallbackIcon.classList.add('hidden');
    if (btnRemoveLogo) btnRemoveLogo.classList.remove('hidden');

    if (feedback && feedbackText) {
      feedback.classList.remove('hidden');
      feedbackText.textContent = `Logo ready (${file.name}). Click "Save Store Settings" to apply.`;
    }

    updateSettingsPreview();
    showToast('✨ Logo ready! Click Save to apply.');
  } catch (err) {
    console.error(err);
    showToast('⚠️ ' + (err.message || 'Error processing logo image'));
  }
};

window.handleLogoUrlInput = function(url) {
  const clean = (url || '').trim();
  const setLogoData = document.getElementById('setLogoData');
  const setLogoImgPreview = document.getElementById('setLogoImgPreview');
  const setLogoFallbackIcon = document.getElementById('setLogoFallbackIcon');
  const btnRemoveLogo = document.getElementById('btnRemoveLogo');
  const feedback = document.getElementById('logoUploadFeedback');

  if (clean) {
    if (setLogoData) setLogoData.value = clean;
    if (setLogoImgPreview) {
      setLogoImgPreview.src = clean;
      setLogoImgPreview.classList.remove('hidden');
    }
    if (setLogoFallbackIcon) setLogoFallbackIcon.classList.add('hidden');
    if (btnRemoveLogo) btnRemoveLogo.classList.remove('hidden');
    if (feedback) feedback.classList.remove('hidden');
    updateSettingsPreview();
  } else {
    clearStoreLogo();
  }
};

window.clearStoreLogo = function() {
  const setLogoData = document.getElementById('setLogoData');
  const setLogoUrl = document.getElementById('setLogoUrl');
  const setLogoImgPreview = document.getElementById('setLogoImgPreview');
  const setLogoFallbackIcon = document.getElementById('setLogoFallbackIcon');
  const btnRemoveLogo = document.getElementById('btnRemoveLogo');
  const fileInput = document.getElementById('setLogoFileInput');
  const feedback = document.getElementById('logoUploadFeedback');

  if (setLogoData) setLogoData.value = '';
  if (setLogoUrl) setLogoUrl.value = '';
  if (fileInput) fileInput.value = '';
  if (setLogoImgPreview) {
    setLogoImgPreview.src = '';
    setLogoImgPreview.classList.add('hidden');
  }
  if (setLogoFallbackIcon) setLogoFallbackIcon.classList.remove('hidden');
  if (btnRemoveLogo) btnRemoveLogo.classList.add('hidden');
  if (feedback) feedback.classList.add('hidden');
  updateSettingsPreview();
};

// Product Photo Upload Handlers for Stock CRM
window.handleProductImageSelect = async function(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    showToast('⏳ Optimizing product photo...');
    const dataUrl = await compressImageFile(file, 600, 600, 0.85);

    const dataInput = document.getElementById('newProdImgData');
    const urlInput = document.getElementById('newProdImgUrl');
    const preview = document.getElementById('newProdImgPreview');
    const fallback = document.getElementById('newProdImgFallback');
    const btnRemove = document.getElementById('btnRemoveProdImg');

    if (dataInput) dataInput.value = dataUrl;
    if (urlInput) urlInput.value = '';
    if (preview) {
      preview.src = dataUrl;
      preview.classList.remove('hidden');
    }
    if (fallback) fallback.classList.add('hidden');
    if (btnRemove) btnRemove.classList.remove('hidden');

    showToast('📸 Product photo attached!');
  } catch (err) {
    console.error(err);
    showToast('⚠️ ' + (err.message || 'Error processing product photo'));
  }
};

window.handleProductImageUrl = function(url) {
  const clean = (url || '').trim();
  const dataInput = document.getElementById('newProdImgData');
  const preview = document.getElementById('newProdImgPreview');
  const fallback = document.getElementById('newProdImgFallback');
  const btnRemove = document.getElementById('btnRemoveProdImg');

  if (clean) {
    if (dataInput) dataInput.value = clean;
    if (preview) {
      preview.src = clean;
      preview.classList.remove('hidden');
    }
    if (fallback) fallback.classList.add('hidden');
    if (btnRemove) btnRemove.classList.remove('hidden');
  } else {
    clearNewProductImage();
  }
};

window.clearNewProductImage = function() {
  const dataInput = document.getElementById('newProdImgData');
  const urlInput = document.getElementById('newProdImgUrl');
  const fileInput = document.getElementById('newProdImgFile');
  const preview = document.getElementById('newProdImgPreview');
  const fallback = document.getElementById('newProdImgFallback');
  const btnRemove = document.getElementById('btnRemoveProdImg');

  if (dataInput) dataInput.value = '';
  if (urlInput) urlInput.value = '';
  if (fileInput) fileInput.value = '';
  if (preview) {
    preview.src = '';
    preview.classList.add('hidden');
  }
  if (fallback) fallback.classList.remove('hidden');
  if (btnRemove) btnRemove.classList.add('hidden');
};

window.updateSettingsPreview = function() {
  const brandVal = document.getElementById('setBrandName')?.value.trim();
  const locVal = document.getElementById('setStoreLocation')?.value.trim();
  const instaVal = document.getElementById('setStoreInstagram')?.value.trim().replace(/^@/, '');
  const assuranceVal = document.getElementById('setAssuranceText')?.value.trim();
  const logoData = document.getElementById('setLogoData')?.value.trim() || document.getElementById('setLogoUrl')?.value.trim();

  const prevBrandNameText = document.getElementById('prevBrandNameText');
  const prevLogoImg = document.getElementById('prevLogoImg');
  const prevLogoFallback = document.getElementById('prevLogoFallback');
  const prevLocText = document.getElementById('prevLocText');
  const prevInstaText = document.getElementById('prevInstaText');
  const prevAssuranceText = document.getElementById('prevAssuranceText');
  const prevLocBadge = document.getElementById('prevLocBadge');
  const prevInstaBadge = document.getElementById('prevInstaBadge');

  if (prevBrandNameText) prevBrandNameText.textContent = brandVal || 'Store Name';

  if (logoData) {
    if (prevLogoImg) {
      prevLogoImg.src = logoData;
      prevLogoImg.classList.remove('hidden');
    }
    if (prevLogoFallback) prevLogoFallback.classList.add('hidden');
  } else {
    if (prevLogoImg) {
      prevLogoImg.src = '';
      prevLogoImg.classList.add('hidden');
    }
    if (prevLogoFallback) prevLogoFallback.classList.remove('hidden');
  }

  if (prevLocText) prevLocText.textContent = locVal || 'Physical Location (optional)';
  if (prevLocBadge) prevLocBadge.style.opacity = locVal ? '1' : '0.4';

  if (prevInstaText) prevInstaText.textContent = instaVal ? `@${instaVal}` : '@instagram (optional)';
  if (prevInstaBadge) prevInstaBadge.style.opacity = instaVal ? '1' : '0.4';

  if (prevAssuranceText) {
    prevAssuranceText.textContent = assuranceVal ? `✨ ${assuranceVal}` : '✨ Your item is handcrafted and reserved exclusively for you';
  }
};

async function handleSaveStoreSettings() {
  const brandName = document.getElementById('setBrandName')?.value.trim();
  const ownerName = document.getElementById('setOwnerName')?.value.trim();
  const brandCategory = document.getElementById('setCategory')?.value;
  const phone = document.getElementById('setPhone')?.value.trim();
  const upiId = document.getElementById('setUpiId')?.value.trim();
  const storeLocation = document.getElementById('setStoreLocation')?.value.trim();
  const storeInstagram = document.getElementById('setStoreInstagram')?.value.trim();
  const assuranceText = document.getElementById('setAssuranceText')?.value.trim();
  const storeLogo = document.getElementById('setLogoData')?.value.trim() || document.getElementById('setLogoUrl')?.value.trim() || '';
  const newPassword = document.getElementById('setNewPassword')?.value.trim();

  // Banking Automation Settings
  const bankCode = document.getElementById('setBankCode')?.value || 'ICICI';
  const verifiedSenderEmail = document.getElementById('setVerifiedSenderEmail')?.value.trim() || '';
  const imapUser = document.getElementById('setBankImapUser')?.value.trim() || '';
  const imapAppPassword = document.getElementById('setBankImapPassword')?.value.trim() || '';
  const monitoringActive = Boolean(document.getElementById('setBankMonitoringActive')?.checked);

  const bankingAutomation = {
    bankCode,
    verifiedSenderEmail,
    imapUser,
    monitoringActive
  };
  if (imapAppPassword) {
    bankingAutomation.imapAppPassword = imapAppPassword;
  }

  if (!brandName || !upiId) {
    showToast('⚠️ Store Name and Direct UPI ID are required.');
    return;
  }

  const btn = document.getElementById('btnSaveSettings');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">refresh</span><span>Saving Settings...</span>`;

  try {
    const res = await fetch('/api/store/settings', {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        brandName,
        ownerName,
        brandCategory,
        phone,
        upiId,
        storeLocation,
        storeInstagram,
        storeLogo,
        assuranceText,
        newPassword: newPassword || undefined,
        bankingAutomation
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ Store profile, logo & banking rails updated!');
      if (newPassword) {
        document.getElementById('setNewPassword').value = '';
      }
      if (imapAppPassword) {
        const passEl = document.getElementById('setBankImapPassword');
        if (passEl) {
          passEl.value = '';
          passEl.placeholder = '•••••••••••••••• (Saved - leave blank to keep current)';
        }
      }
      await checkAuthAndLoadSeller();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to save settings'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// -------------------------------------------------------------
// Direct Bank Credit Email Automation & Anti-Spoofing Helpers
// -------------------------------------------------------------
const BANK_PRESET_SENDERS = {
  ICICI: 'bankingalerts@icicibank.com',
  HDFC: 'alerts@hdfcbank.net',
  SBI: 'sbialerts@sbi.co.in',
  AXIS: 'alerts@axisbank.com',
  KOTAK: 'alerts@kotak.com',
  PNB: 'alerts@pnb.co.in',
  BOB: 'alerts@bankofbaroda.com',
  CUSTOM: ''
};

const BANK_PRESET_CHIPS = {
  ICICI: ['bankingalerts@icicibank.com', 'alerts@icicibank.com', 'customeralerts@icicibank.com'],
  HDFC: ['alerts@hdfcbank.net', 'netbanking@hdfcbank.net'],
  SBI: ['sbialerts@sbi.co.in', 'donotreply@sbi.co.in'],
  AXIS: ['alerts@axisbank.com', 'axisbank@axisbank.com'],
  KOTAK: ['alerts@kotak.com'],
  PNB: ['alerts@pnb.co.in'],
  BOB: ['alerts@bankofbaroda.com'],
  CUSTOM: ['@yourbank.com', 'alerts@yourbank.com']
};

window.renderBankSenderChips = function(code) {
  const container = document.getElementById('bankSenderChips');
  if (!container) return;
  const chips = BANK_PRESET_CHIPS[code] || BANK_PRESET_CHIPS.CUSTOM;
  container.innerHTML = chips.map(chip => `
    <button type="button" onclick="setVerifiedSenderChip('${chip}')" class="text-[9px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-600 border border-slate-200 transition-colors cursor-pointer flex items-center gap-1">
      <span class="material-symbols-outlined text-[10px]">add</span>
      <span>${chip}</span>
    </button>
  `).join('');
};

window.setVerifiedSenderChip = function(email) {
  const senderInput = document.getElementById('setVerifiedSenderEmail');
  if (!senderInput) return;
  senderInput.value = email;
  senderInput.focus();
  senderInput.classList.add('ring-2', 'ring-indigo-400');
  setTimeout(() => senderInput.classList.remove('ring-2', 'ring-indigo-400'), 500);
  showToast(`✅ Selected bank alert sender: ${email}`);
};

window.focusCustomSenderInput = function() {
  const senderInput = document.getElementById('setVerifiedSenderEmail');
  const bankSelect = document.getElementById('setBankCode');
  if (bankSelect) {
    bankSelect.value = 'CUSTOM';
    renderBankSenderChips('CUSTOM');
  }
  if (senderInput) {
    senderInput.focus();
    senderInput.select();
  }
  showToast('✏️ Type any custom bank alert sender email or domain');
};

window.onSenderInputTyped = function() {
  const senderInput = document.getElementById('setVerifiedSenderEmail');
  const bankSelect = document.getElementById('setBankCode');
  if (!senderInput || !bankSelect) return;
  const val = senderInput.value.toLowerCase().trim();
  let matchedCode = null;
  for (const [code, email] of Object.entries(BANK_PRESET_SENDERS)) {
    if (code !== 'CUSTOM' && email && val === email.toLowerCase()) {
      matchedCode = code;
      break;
    }
  }
  if (matchedCode) {
    bankSelect.value = matchedCode;
    renderBankSenderChips(matchedCode);
  } else if (bankSelect.value !== 'CUSTOM') {
    bankSelect.value = 'CUSTOM';
    renderBankSenderChips('CUSTOM');
  }
};

window.onBankSelectChange = function(resetSender = false) {
  const bankSelect = document.getElementById('setBankCode');
  const senderInput = document.getElementById('setVerifiedSenderEmail');
  if (!bankSelect || !senderInput) return;

  const code = bankSelect.value;
  if (code === 'CUSTOM') {
    senderInput.placeholder = 'e.g. alerts@yourbank.com, @yourbank.com';
    if (resetSender && (!senderInput.value || Object.values(BANK_PRESET_SENDERS).includes(senderInput.value))) {
      senderInput.value = '';
    }
    senderInput.focus();
  } else {
    if (resetSender || !senderInput.value) {
      senderInput.value = BANK_PRESET_SENDERS[code] || 'bankingalerts@icicibank.com';
    }
    senderInput.placeholder = BANK_PRESET_SENDERS[code] || 'e.g. alerts@yourbank.com';
  }

  renderBankSenderChips(code);
};

window.copyStoreWebhookUrl = function() {
  const storeId = (currentSeller && currentSeller.id) ? currentSeller.id : '';
  const url = `${window.location.origin}/api/webhook/bank-email${storeId ? `?storeId=${storeId}` : ''}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 Webhook URL copied! Point Zapier / CloudMailin / Forwarder to this URL.');
  }).catch(() => {
    prompt('Copy Webhook URL:', url);
  });
};

window.testEmailConnection = async function() {
  const btn = document.getElementById('btnTestEmailConn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[15px] animate-spin">refresh</span><span>Connecting...</span>`;
  }

  try {
    const res = await fetch('/api/seller/test-email-connection', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        bankCode: document.getElementById('setBankCode')?.value,
        imapUser: document.getElementById('setBankImapUser')?.value?.trim(),
        imapAppPassword: document.getElementById('setBankImapPassword')?.value?.trim() || undefined
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ ${data.message}`);
    } else {
      alert(`⚠️ Email Connection Issue:\n\n${data.error || 'Could not connect to Gmail IMAP.'}\n\nTips:\n1. Enable 2-Step Verification in Google Account.\n2. Create a 16-character App Password at myaccount.google.com/apppasswords.\n3. Paste the code into the App Password field.`);
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Could not test email connection');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
};

window.openTestEmailModal = function() {
  const modal = document.getElementById('modalTestEmail');
  if (!modal) return;
  const verifiedSender = document.getElementById('setVerifiedSenderEmail')?.value || 'bankingalerts@icicibank.com';
  const testFrom = document.getElementById('testEmailFrom');
  if (testFrom) testFrom.value = verifiedSender;
  const domainInfo = document.getElementById('testSenderDomainInfo');
  if (domainInfo) domainInfo.textContent = verifiedSender;

  loadSampleEmailPreset('icici');
  document.getElementById('testEmailResult')?.classList.add('hidden');
  modal.classList.remove('hidden');
};

window.closeTestEmailModal = function() {
  document.getElementById('modalTestEmail')?.classList.add('hidden');
};

window.loadSampleEmailPreset = function(type) {
  const verifiedSender = document.getElementById('setVerifiedSenderEmail')?.value || 'bankingalerts@icicibank.com';
  const fromInput = document.getElementById('testEmailFrom');
  const bodyInput = document.getElementById('testEmailBody');
  if (!fromInput || !bodyInput) return;

  const ordersList = (typeof cachedOrders !== 'undefined' && Array.isArray(cachedOrders)) ? cachedOrders : [];
  const pending = ordersList.find(o => o.status === 'PENDING');
  const ref = pending ? (pending.storeRef || pending.ref || pending.orderRef || '#ACH-034') : '#ACH-034';
  const token = pending ? pending.token : 'ach_cace51ccbf';
  const amt = pending ? (pending.payableAmount || pending.amount || 50) : 50;

  if (type === 'icici') {
    fromInput.value = 'bankingalerts@icicibank.com';
    bodyInput.value = `Dear Customer,\n\nYour Account ending in XX789 has been credited with INR ${amt}.00 on 01-Nov-2026.\nTransaction Info: UPI/${ref}/IMPS/${token}/Payment received from Radhika Sharma.\nRef/UTR No: 430588912345.\n\nThank you for banking with ICICI Bank.`;
  } else if (type === 'hdfc') {
    fromInput.value = 'alerts@hdfcbank.net';
    bodyInput.value = `Dear Merchant,\n\nRs. ${amt}.00 credited to your HDFC Bank A/c ending 4410 on 01-11-2026 by UPI payment (Ref ${ref}, ${token}).\nUTR: 430512895671.\n\nWarm regards,\nHDFC Bank SmartHub Team`;
  } else if (type === 'sbi') {
    fromInput.value = 'sbialerts@sbi.co.in';
    bodyInput.value = `Dear Customer, your A/C 9812 has a credit by UPI of Rs ${amt}.00 on 01Nov26 transfer from Priya Verma (UPI Ref ${ref} / ${token}). Balance: INR 1,42,850.00 - SBI.`;
  } else if (type === 'spoofed') {
    fromInput.value = 'fake-scammer99@gmail.com';
    bodyInput.value = `ALERT: You received INR ${amt}.00 for ${ref} immediately! Please release shipment.`;
  }
};

window.submitTestEmailIngestion = async function() {
  const fromAddress = document.getElementById('testEmailFrom')?.value?.trim();
  const emailText = document.getElementById('testEmailBody')?.value?.trim();
  const btn = document.getElementById('btnRunTestEmail');
  const resultCard = document.getElementById('testEmailResult');
  const resHeader = document.getElementById('testResultHeader');
  const resTitle = document.getElementById('testResultTitle');
  const resIcon = document.getElementById('testResultIcon');
  const resHeading = document.getElementById('testResultHeading');
  const resBadge = document.getElementById('testResultBadge');
  const resDesc = document.getElementById('testResultDesc');
  const resDetails = document.getElementById('testResultDetails');

  if (!emailText) {
    showToast('⚠️ Please enter sample email text.');
    return;
  }

  const origBtnHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">refresh</span><span>Processing Alert...</span>`;
  }

  try {
    const res = await fetch('/api/seller/test-ingest-email', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ emailText, fromAddress })
    });
    const data = await res.json();

    if (resultCard) {
      resultCard.classList.remove('hidden', 'bg-emerald-50', 'border-emerald-200', 'bg-rose-50', 'border-rose-200', 'bg-amber-50', 'border-amber-200');

      if (res.ok && data.success) {
        resultCard.classList.add('bg-emerald-50', 'border-emerald-200');
        if (resIcon) {
          resIcon.textContent = 'check_circle';
          resIcon.className = 'material-symbols-outlined text-[17px] text-emerald-600';
        }
        if (resHeading) {
          resHeading.textContent = 'Order Auto-Settled & Marked PAID!';
          resHeading.className = 'font-bold text-emerald-800';
        }
        if (resBadge) {
          const ordRef = data.order?.storeRef || data.order?.ref || data.order?.orderRef || (data.order?.token ? `#${data.order.token}` : '');
          resBadge.textContent = ordRef ? `Order ${ordRef}` : (data.utr ? `UTR ${data.utr}` : 'Settled');
          resBadge.className = 'font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-800 font-bold';
        }
        if (resDesc) {
          resDesc.textContent = `Matched via ${data.matchReason || 'Bank Credit Email'}. Stock automatically reserved & decremented.`;
          resDesc.className = 'text-[11px] text-emerald-700 leading-relaxed';
        }
        if (resDetails) {
          resDetails.classList.remove('hidden');
          const ordRef = data.order?.storeRef || data.order?.ref || data.order?.orderRef || data.order?.token || '--';
          resDetails.innerHTML = `
            <div><strong>Sender:</strong> <span class="text-emerald-700 font-bold">✓ ${fromAddress} (Verified Official Bank Alert)</span></div>
            <div><strong>Parsed Amount:</strong> ₹${data.parsed?.amount || '--'} | <strong>UTR:</strong> ${data.parsed?.utr || 'None'}</div>
            <div><strong>Matched Order:</strong> ${ordRef} (${data.order?.customerName || 'Customer'}) - Status: <strong class="text-emerald-800">PAID</strong></div>
          `;
        }
        showToast('🎉 Order matched and settled!');
        if (typeof fetchOrdersAndMetrics === 'function') await fetchOrdersAndMetrics();
        if (typeof loadMasterInventory === 'function') await loadMasterInventory();
      } else {
        const isSecurity = data.error && data.error.includes('Email rejected');
        resultCard.classList.add(isSecurity ? 'bg-rose-50' : 'bg-amber-50', isSecurity ? 'border-rose-200' : 'border-amber-200');
        if (resIcon) {
          resIcon.textContent = isSecurity ? 'gpp_bad' : 'warning';
          resIcon.className = `material-symbols-outlined text-[17px] ${isSecurity ? 'text-rose-600' : 'text-amber-600'}`;
        }
        if (resHeading) {
          resHeading.textContent = isSecurity ? 'Security Guard: Rejected Spoofed Sender' : 'Alert Processed - No Pending Match';
          resHeading.className = `font-bold ${isSecurity ? 'text-rose-800' : 'text-amber-800'}`;
        }
        if (resBadge) {
          resBadge.textContent = isSecurity ? 'BLOCKED' : 'NO MATCH';
          resBadge.className = `font-mono text-[10px] px-2 py-0.5 rounded-full ${isSecurity ? 'bg-rose-200 text-rose-800' : 'bg-amber-200 text-amber-800'} font-bold`;
        }
        if (resDesc) {
          resDesc.textContent = data.error || data.reason || 'Could not match this alert to any pending order.';
          resDesc.className = `text-[11px] ${isSecurity ? 'text-rose-700' : 'text-amber-700'} leading-relaxed`;
        }
        if (resDetails && data.parsed) {
          resDetails.classList.remove('hidden');
          resDetails.innerHTML = `
            <div><strong>Parsed Amount:</strong> ₹${data.parsed.amount || 'Not found'}</div>
            <div><strong>Parsed Token / Ref:</strong> ${data.parsed.token || data.parsed.orderRef || 'Not found'}</div>
            <div><strong>Parsed UTR:</strong> ${data.parsed.utr || 'Not found'}</div>
          `;
        }
      }
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Error testing email ingestion');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origBtnHtml;
    }
  }
};

// 4. Quick Sale Modal (For Owner to issue link without leaving Master Dashboard)
function openQuickSaleModal() {
  const modal = document.getElementById('modalQuickSale');
  if (modal) {
    document.getElementById('qsCustName').value = '';
    document.getElementById('qsCustPhone').value = '';
    document.getElementById('qsItemDesc').value = '';
    document.getElementById('qsAmount').value = '';
    document.getElementById('qsResultCard').classList.add('hidden');
    modal.classList.remove('hidden');
    document.getElementById('qsCustName').focus();
  }
}

function closeQuickSaleModal() {
  const modal = document.getElementById('modalQuickSale');
  if (modal) modal.classList.add('hidden');
}

let lastQsUrl = '';
async function handleQuickSaleSubmit() {
  const custName = document.getElementById('qsCustName').value.trim();
  const custPhone = document.getElementById('qsCustPhone').value.trim();
  const itemDesc = document.getElementById('qsItemDesc').value.trim();
  const amount = document.getElementById('qsAmount').value;

  if (!itemDesc || !amount) {
    showToast('⚠️ Item description and amount are required');
    return;
  }

  const btn = document.getElementById('btnQuickSaleSubmit');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">refresh</span><span>Generating Rail...</span>`;

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        customerName: custName,
        customerPhone: custPhone,
        itemDescription: itemDesc,
        amount: amount
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      lastQsUrl = data.payUrl;
      const resultCard = document.getElementById('qsResultCard');
      const refDisplay = document.getElementById('qsRefDisplay');
      const linkUrl = document.getElementById('qsLinkUrl');
      const waButton = document.getElementById('qsWaButton');

      if (refDisplay) refDisplay.textContent = `#REF-${data.order.ref}`;
      if (linkUrl) linkUrl.textContent = data.payUrl;
      if (waButton) waButton.href = data.waLink;
      if (resultCard) resultCard.classList.remove('hidden');

      const displayName = custName || `Order #REF-${data.order.ref}`;
      showToast(`🎉 Link generated for ${displayName}!`);
      await fetchOrdersAndMetrics();
      renderActiveMasterView();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to generate link'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function copyQsLink() {
  if (lastQsUrl) {
    navigator.clipboard.writeText(lastQsUrl);
    showToast('📋 Copied payment link to clipboard!');
  }
}

window.adjustQsAmount = function(delta) {
  const input = document.getElementById('qsAmount');
  if (!input) return;
  const current = parseFloat(input.value) || 0;
  input.value = Math.max(1, current + delta);
};

window.shareQsLinkNative = async function() {
  if (!lastQsUrl) return;
  const refDisplay = document.getElementById('qsRefDisplay');
  const ref = refDisplay ? refDisplay.textContent : 'Payment';
  const itemDesc = document.getElementById('qsItemDesc')?.value || 'Reserved Piece';
  const amount = document.getElementById('qsAmount')?.value || '';

  if (navigator.share) {
    try {
      await navigator.share({
        title: `${ref} - Payment Link`,
        text: `Namaste! Here is your reserved order link for ${itemDesc}${amount ? ' (₹' + amount + ')' : ''}. Confirm address & pay:\n${lastQsUrl}`,
        url: lastQsUrl
      });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyQsLink();
};

window.shareOrderLinkMobile = async function(ref, url, title, amount) {
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Order #REF-${ref}`,
        text: `Namaste! Your order link for ${title} (₹${amount}) is ready. Please confirm delivery address & pay:\n${url}`,
        url: url
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  navigator.clipboard.writeText(url);
  showToast('📋 Order payment link copied to clipboard!');
};

window.shareCurrentOrderMobile = async function() {
  if (!activeOrder) {
    showToast('⚠️ No active order selected');
    return;
  }
  const origin = window.location.origin;
  const payUrl = `${origin}/pay?ref=${activeOrder.ref}`;
  const item = activeOrder.itemDescription || 'Reserved Piece';
  const amt = (activeOrder.payableAmount !== undefined ? activeOrder.payableAmount : activeOrder.amount) || '0';
  await window.shareOrderLinkMobile(activeOrder.ref, payUrl, item, amt);
};

function togglePinReveal(smId, actualPin) {
  const el = document.getElementById(`pinDisplay_${smId}`);
  const icon = document.getElementById(`pinIcon_${smId}`);
  if (!el) return;
  if (el.textContent === '••••') {
    el.textContent = actualPin;
    if (icon) icon.textContent = 'visibility_off';
  } else {
    el.textContent = '••••';
    if (icon) icon.textContent = 'visibility';
  }
}

// Salesman Management Modals
function openAddSalesmanModal() {
  const modal = document.getElementById('addSalesmanModal');
  if (modal) {
    document.getElementById('newSmName').value = '';
    document.getElementById('newSmPin').value = '';
    const chk = document.getElementById('newSmStockAccess');
    if (chk) chk.checked = false;
    modal.classList.remove('hidden');
    document.getElementById('newSmName').focus();
  }
}

function closeAddSalesmanModal() {
  const modal = document.getElementById('addSalesmanModal');
  if (modal) modal.classList.add('hidden');
}

async function handleAddSalesmanSubmit() {
  const name = document.getElementById('newSmName').value.trim();
  const pin = document.getElementById('newSmPin').value.trim();
  const stockAccess = Boolean(document.getElementById('newSmStockAccess')?.checked);
  if (!name || pin.length < 4) {
    showToast('⚠️ Please enter salesman name and 4-digit PIN');
    return;
  }

  const btn = document.getElementById('btnAddSmSubmit');
  const orig = btn.innerText;
  btn.disabled = true;
  btn.innerText = 'Creating...';

  try {
    const res = await fetch('/api/store/salesmen', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, pin, stockAccess })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🎉 Salesman ${name} added with PIN: ${pin}!`);
      closeAddSalesmanModal();
      await fetchOrdersAndMetrics();
      renderMasterDashboard();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to add salesman'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  } finally {
    btn.disabled = false;
    btn.innerText = orig;
  }
}

function openEditSalesmanModal(id, name, currentPin, stockAccess = false) {
  const modal = document.getElementById('editSalesmanModal');
  if (modal) {
    document.getElementById('editSmId').value = id;
    document.getElementById('editSmName').value = name;
    document.getElementById('editSmPin').value = currentPin;
    const chk = document.getElementById('editSmStockAccess');
    if (chk) chk.checked = Boolean(stockAccess);
    modal.classList.remove('hidden');
    document.getElementById('editSmPin').focus();
  }
}

function closeEditSalesmanModal() {
  const modal = document.getElementById('editSalesmanModal');
  if (modal) modal.classList.add('hidden');
}

async function handleEditSalesmanSubmit() {
  const id = document.getElementById('editSmId').value;
  const name = document.getElementById('editSmName').value.trim();
  const pin = document.getElementById('editSmPin').value.trim();
  const stockAccess = Boolean(document.getElementById('editSmStockAccess')?.checked);
  if (!name || pin.length < 4) {
    showToast('⚠️ Salesman name and 4-digit PIN are required');
    return;
  }

  const btn = document.getElementById('btnEditSmSubmit');
  const orig = btn.innerText;
  btn.disabled = true;
  btn.innerText = 'Saving...';

  try {
    const res = await fetch(`/api/store/salesmen/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, pin, stockAccess })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Updated settings for ${name}!`);
      closeEditSalesmanModal();
      await fetchOrdersAndMetrics();
      renderMasterDashboard();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to update salesman'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server error');
  } finally {
    btn.disabled = false;
    btn.innerText = orig;
  }
}

async function handleToggleStaffStockAccess(id, newAccess) {
  try {
    const res = await fetch(`/api/store/salesmen/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ stockAccess: newAccess })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Stock CRM permission ${newAccess ? 'granted to' : 'revoked from'} ${data.salesman.name}`);
      await fetchOrdersAndMetrics();
      renderMasterDashboard();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to update stock permission'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server error updating permissions');
  }
}

async function handleDeleteSalesman(id, name) {
  if (!confirm(`Are you sure you want to remove ${name} from this store?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/store/salesmen/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Salesman ${name} removed`);
      await fetchOrdersAndMetrics();
      renderMasterDashboard();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to delete'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server error');
  }
}

// Simulate an incoming bank credit email for current sale
async function triggerTestBankWebhook() {
  if (!activeOrder && (!cachedOrders || cachedOrders.length === 0)) {
    showToast('⚠️ Please create a sale first before simulating bank confirmation');
    return;
  }

  const target = activeOrder || cachedOrders.find(o => o.status === 'PENDING') || cachedOrders[0];
  if (!target) {
    showToast('⚠️ No pending sale found to confirm');
    return;
  }

  try {
    showToast(`📩 Simulating incoming Bank Payment Alert for #REF-${target.ref}...`);
    const res = await fetch('/api/webhook/simulate-bank-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: target.ref,
        bankName: 'HDFC Bank'
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Verified! Bank Settlement Reference: ${data.utr}`);
      playCashChime();
      await fetchOrdersAndMetrics();
      if (data.order) {
        activeOrder = data.order;
        renderCockpit(data.order);
      }
      renderMasterDispatchTable();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to simulate payment'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Failed to connect to bank simulation engine');
  }
}

// Render Bottom All Orders Table
function renderOrdersTable() {
  if (currentMasterTab === 'dispatch') {
    renderMasterDispatchTable();
  }
  const tbody = document.getElementById('recentTableBody');
  const mobileList = document.getElementById('recentMobileList');
  if (!tbody && !mobileList) return;

  let list = [...cachedOrders];
  if (currentFilter !== 'ALL') {
    list = list.filter(o => o.status === currentFilter);
  }

  if (list.length === 0) {
    const emptyHtml = `
      <div class="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
        <span class="material-symbols-outlined text-[28px] text-slate-300">link_off</span>
        <p class="text-xs font-semibold text-slate-500">No payment links created yet.</p>
        <p class="text-[11px] text-slate-400">Select an item from the database or enter details above to generate your first order link.</p>
      </div>
    `;
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-0">${emptyHtml}</td></tr>`;
    if (mobileList) mobileList.innerHTML = emptyHtml;
    return;
  }

  // 1. Desktop Table Rows (100% Intact)
  if (tbody) {
    tbody.innerHTML = list.map(order => {
      const cleanName = (order.customerName || '').trim();
      const displayName = cleanName || `#REF-${order.ref}`;
      const initials = cleanName 
        ? cleanName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() 
        : `#${order.ref}`;
      const isPaid = order.status === 'PAID';
      const isRedirected = order.steps && order.steps.redirectedToPayment && order.steps.redirectedToPayment.done;
      const isOpened = order.steps && order.steps.opened && order.steps.opened.done;
      const origin = window.location.origin;
      const payUrl = `${origin}/pay?token=${order.token || order.ref}`;
      const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);

      let statusBadge = '';
      if (isPaid) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold border border-emerald-200">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Paid & Synced
        </span>`;
      } else if (isRedirected) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[11px] font-bold border border-purple-200">
          <span class="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span> In Payment App
        </span>`;
      } else if (isOpened) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-bold border border-blue-200">
          <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Link Opened
        </span>`;
      } else {
        statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-bold border border-amber-200">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span> Waiting Response
        </span>`;
      }

      const avatarBg = isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700';

      const salesmanBadgeHtml = currentRole === 'OWNER' && order.salesmanName 
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-bold border border-indigo-100/70">
             <span class="w-1 h-1 rounded-full bg-indigo-600"></span>
             ${escapeHtml(order.salesmanName)}
           </span>`
        : '';

      return `
        <tr class="hover:bg-slate-50/70 transition-colors cursor-pointer" onclick="activateTab('${order.ref}')">
          <td class="py-3.5 px-4">
            <div class="flex items-center gap-2.5">
              <div class="w-7 h-7 rounded-full ${avatarBg} font-bold flex items-center justify-center text-xs shrink-0">${initials}</div>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-bold text-slate-900 block truncate">${escapeHtml(displayName)}</span>
                  ${salesmanBadgeHtml}
                </div>
                <span class="text-[11px] text-slate-400 block truncate">#REF-${order.ref} ${order.customerPhone ? '• +91 ' + escapeHtml(order.customerPhone) : ''}</span>
              </div>
            </div>
          </td>
          <td class="py-3.5 px-4 max-w-xs truncate text-slate-800">
            ${order.sku ? `<span class="font-mono text-indigo-600 font-bold text-[10px] mr-1">#${escapeHtml(order.sku)}</span>` : ''}
            ${escapeHtml(order.itemDescription)}
          </td>
          <td class="py-3.5 px-4 text-slate-500 whitespace-nowrap text-xs">
            ${isPaid ? (order.paymentMethod || 'Bank Email Verified') : 'Direct UPI Hold'}
          </td>
          <td class="py-3.5 px-4 font-bold text-slate-900 whitespace-nowrap">
            ₹${payableAmt}
          </td>
          <td class="py-3.5 px-4">
            ${statusBadge}
          </td>
          <td class="py-3.5 px-4 text-right" onclick="event.stopPropagation()">
            <div class="flex items-center justify-end gap-1.5">
              <button type="button" onclick="activateTab('${order.ref}')" class="px-2.5 py-1 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 font-semibold rounded-lg text-[11px] shadow-2xs transition-all cursor-pointer">
                Open Tab
              </button>
              <button type="button" onclick="copyToClipboard('${payUrl}', null)" class="px-2.5 py-1 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 font-semibold rounded-lg text-[11px] shadow-2xs transition-all cursor-pointer">
                Copy Link
              </button>
              <a href="${payUrl}" target="_blank" class="p-1 hover:bg-slate-100 text-slate-400 hover:text-slate-700 rounded-md" title="View Customer Checkout">
                <span class="material-symbols-outlined text-[15px]">open_in_new</span>
              </a>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 2. Mobile Cards Feed (Touch-Optimized for Phones)
  if (mobileList) {
    mobileList.innerHTML = list.map(order => {
      const cleanName = (order.customerName || '').trim();
      const displayName = cleanName || `#REF-${order.ref}`;
      const initials = cleanName 
        ? cleanName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() 
        : `#${order.ref}`;
      const isPaid = order.status === 'PAID';
      const isRedirected = order.steps && order.steps.redirectedToPayment && order.steps.redirectedToPayment.done;
      const isOpened = order.steps && order.steps.opened && order.steps.opened.done;
      const origin = window.location.origin;
      const payUrl = `${origin}/pay?token=${order.token || order.ref}`;
      const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);

      let statusBadge = '';
      if (isPaid) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-bold border border-emerald-200">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Paid
        </span>`;
      } else if (isRedirected) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[10px] font-bold border border-purple-200">
          <span class="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span> In App
        </span>`;
      } else if (isOpened) {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200">
          <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Opened
        </span>`;
      } else {
        statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-200">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span> Waiting
        </span>`;
      }

      const avatarBg = isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700';

      return `
        <div class="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-2xs flex flex-col gap-2.5 transition-all active:scale-[0.99] cursor-pointer" onclick="activateTab('${order.ref}')">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-xl ${avatarBg} font-extrabold flex items-center justify-center text-xs shrink-0">
                ${initials}
              </div>
              <div class="min-w-0">
                <div class="font-extrabold text-slate-900 text-xs truncate">${escapeHtml(displayName)}</div>
                <div class="text-[10px] text-slate-400 font-mono">#REF-${order.ref}</div>
              </div>
            </div>
            <div>${statusBadge}</div>
          </div>

          <div class="flex items-center justify-between py-1.5 border-y border-slate-100 text-xs">
            <div class="text-slate-700 font-medium truncate max-w-[65%]">
              ${escapeHtml(order.itemDescription)}
            </div>
            <div class="font-mono font-extrabold text-slate-900 text-sm">
              ₹${payableAmt}
            </div>
          </div>

          <div class="flex items-center justify-between pt-0.5 text-xs">
            <span class="text-[10px] text-slate-400">${order.salesmanName ? escapeHtml(order.salesmanName) : 'Direct Link'}</span>
            <div class="flex items-center gap-1.5">
              <button type="button" onclick="event.stopPropagation(); copyToClipboard('${payUrl}', null)" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-colors">
                Copy
              </button>
              <a href="${payUrl}" target="_blank" onclick="event.stopPropagation();" class="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold transition-colors no-underline">
                Pay Link →
              </a>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

// Cockpit actions
function openWhatsAppForCockpit() {
  if (!activeOrder) return;
  const origin = window.location.origin;
  const payUrl = `${origin}/pay?ref=${activeOrder.ref}`;
  const payableAmt = (activeOrder.payableAmount !== undefined ? activeOrder.payableAmount : activeOrder.amount).toFixed(2);
  const cleanName = (activeOrder.customerName || '').trim();
  const greeting = cleanName ? `Hi ${cleanName.split(' ')[0]}!` : 'Hello!';
  
  const pitch = `${greeting} ✨ Your order for *${activeOrder.itemDescription}* (₹${payableAmt}) with ${activeOrder.brandName || 'our store'} is reserved.\n\nTap below to confirm your shipping address & pay securely via GPay/PhonePe/UPI:\n👉 ${payUrl}\n\nPlease transfer exact ₹${payableAmt} with reference *REF${activeOrder.ref}* for instant automatic bank confirmation!`;
  
  const phone = (activeOrder.customerPhone || '').replace(/\D/g, '');
  if (!phone) {
    window.open(`https://wa.me/?text=${encodeURIComponent(pitch)}`, '_blank');
  } else {
    const targetPhone = phone.startsWith('91') ? phone : '91' + phone;
    window.open(`https://wa.me/${targetPhone}?text=${encodeURIComponent(pitch)}`, '_blank');
  }
}

function copyCockpitLink() {
  if (!activeOrder) return;
  const origin = window.location.origin;
  const payUrl = `${origin}/pay?ref=${activeOrder.ref}`;
  copyToClipboard(payUrl, null);
  const textEl = document.getElementById('btnCopyCockpitLinkText');
  if (textEl) {
    const orig = textEl.innerText;
    textEl.innerText = 'Copied Link!';
    setTimeout(() => { textEl.innerText = orig; }, 1500);
  }
}

function copyCurrentLink() {
  const origin = window.location.origin;
  const url = activeRefNumber ? `${origin}/pay?ref=${activeRefNumber}` : `${origin}/pay`;
  copyToClipboard(url, 'linkBtn');
}

function copyToClipboard(text, btnId) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("Link copied to clipboard!");
    if (btnId) {
      const btn = document.getElementById(btnId);
      if (btn) {
        const orig = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => { btn.innerText = orig; }, 1500);
      }
    }
  });
}

function copyPitchText() {
  const pitch = document.getElementById('pitchPreview').innerText;
  navigator.clipboard.writeText(pitch).then(() => {
    showToast("Full WhatsApp pitch copied!");
    const btn = document.getElementById('copyPitchBtn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<span class="material-symbols-outlined text-[15px]">check</span><span>Copied!</span>`;
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  });
}

function openWhatsAppDirect() {
  if (activeOrder && activeOrder.waLink) {
    window.open(activeOrder.waLink, '_blank');
    return;
  }
  const phone = (document.getElementById('custPhone')?.value || '').replace(/[^0-9]/g, '');
  const pitch = encodeURIComponent(document.getElementById('pitchPreview')?.innerText || '');
  if (!phone) {
    window.open(`https://wa.me/?text=${pitch}`, '_blank');
  } else {
    const targetPhone = phone.startsWith('91') ? phone : '91' + phone;
    window.open(`https://wa.me/${targetPhone}?text=${pitch}`, '_blank');
  }
}

function toggleQrModal(show) {
  const modal = document.getElementById('qrModal');
  if (!modal) return;
  if (show) {
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (!toast || !toastMsg) return;
  toastMsg.innerText = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  toast.classList.add('translate-y-0', 'opacity-100');
  setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0');
    toast.classList.remove('translate-y-0', 'opacity-100');
  }, 2800);
}

function formatStepTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// STOCK CRM & REAL-TIME INVENTORY MANAGEMENT
// ==========================================

function openStockCrmView() {
  if (currentRole === 'SALESMAN' && !currentStockAccess) {
    showToast('⚠️ Access denied. Stock CRM management requires permission from store owner.');
    return;
  }
  switchMainView('MASTER');
  setMasterTab('inventory');
}

function renderStockCrmTable() {
  const tbody = document.getElementById('stockCrmTbody');
  if (!tbody) return;

  const totalEl = document.getElementById('stockMetricTotal');
  const inStockEl = document.getElementById('stockMetricInStock');
  const lowStockEl = document.getElementById('stockMetricLowStock');
  const outOfStockEl = document.getElementById('stockMetricOutOfStock');

  const products = cachedProducts || [];

  // Metrics
  const totalCount = products.length;
  const inStockCount = products.filter(p => typeof p.stock === 'number' && p.stock > 0).length;
  const lowStockCount = products.filter(p => typeof p.stock === 'number' && p.stock > 0 && p.stock <= 2).length;
  const outOfStockCount = products.filter(p => typeof p.stock === 'number' && p.stock <= 0).length;

  if (totalEl) totalEl.textContent = totalCount;
  if (inStockEl) inStockEl.textContent = inStockCount;
  if (lowStockEl) lowStockEl.textContent = lowStockCount;
  if (outOfStockEl) outOfStockEl.textContent = outOfStockCount;

  // Filter logic
  let filtered = [...products];
  if (stockSearchQuery) {
    const q = stockSearchQuery.toLowerCase().trim();
    filtered = filtered.filter(p => 
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q))
    );
  }

  if (stockFilterCategory === 'IN_STOCK') {
    filtered = filtered.filter(p => typeof p.stock === 'number' && p.stock > 0);
  } else if (stockFilterCategory === 'OUT_OF_STOCK') {
    filtered = filtered.filter(p => typeof p.stock === 'number' && p.stock <= 0);
  }

  const mobileList = document.getElementById('stockCrmMobileList');

  if (filtered.length === 0) {
    const emptyHtml = `
      <div class="py-10 text-center text-slate-400 flex flex-col items-center justify-center gap-1.5">
        <span class="material-symbols-outlined text-[28px] text-slate-300">inventory_2</span>
        <span class="font-semibold text-xs text-slate-500">No products match your search or filter.</span>
        <span class="text-[11px] text-slate-400">Click "+ Add Product" above to create a new item.</span>
      </div>
    `;
    tbody.innerHTML = `<tr><td colspan="7" class="p-0">${emptyHtml}</td></tr>`;
    if (mobileList) mobileList.innerHTML = emptyHtml;
    return;
  }

  // 1. Desktop Table Rows (100% Intact)
  tbody.innerHTML = filtered.map(prod => {
    const stockQty = typeof prod.stock === 'number' ? prod.stock : 0;
    const isOut = stockQty <= 0;
    const isLow = stockQty > 0 && stockQty <= 2;

    let badge = '';
    if (isOut) {
      badge = `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-rose-50 text-rose-700 border border-rose-200 inline-flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Out of Stock
      </span>`;
    } else if (isLow) {
      badge = `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Low (${stockQty})
      </span>`;
    } else {
      badge = `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${stockQty} in stock
      </span>`;
    }

    const priceFormatted = '₹' + parseFloat(prod.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const controlsDisabled = !currentStockAccess ? 'disabled title="Stock management access required"' : '';
    const controlsOpacity = !currentStockAccess ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer';

    return `
      <tr class="hover:bg-slate-50/80 transition-colors ${isOut ? 'bg-rose-50/20' : ''}">
        <!-- SKU -->
        <td class="py-3 px-3.5 font-mono font-bold text-indigo-600 whitespace-nowrap">
          #${escapeHtml(prod.sku || 'SKU')}
        </td>

        <!-- Item Name & Notes -->
        <td class="py-3 px-3.5 max-w-xs">
          <div class="flex items-center gap-3">
            ${prod.image ? `<img src="${escapeHtml(prod.image)}" alt="" class="w-9 h-9 rounded-xl object-cover border border-slate-200 shrink-0 shadow-2xs" />` : `<div class="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-500 flex items-center justify-center shrink-0 shadow-2xs"><span class="material-symbols-outlined text-[18px]">checkroom</span></div>`}
            <div class="min-w-0">
              <div class="font-bold text-slate-900 truncate">${escapeHtml(prod.name)}</div>
              <div class="text-[11px] text-slate-400 truncate mt-0.5">${escapeHtml(prod.notes || prod.description || '')}</div>
            </div>
          </div>
        </td>

        <!-- Category -->
        <td class="py-3 px-3.5 whitespace-nowrap">
          <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-semibold">
            ${escapeHtml(prod.category || 'Standard')}
          </span>
        </td>

        <!-- Price -->
        <td class="py-3 px-3.5 font-mono font-bold text-slate-900 whitespace-nowrap">
          ${priceFormatted}
        </td>

        <!-- Stock Level Indicator -->
        <td class="py-3 px-3.5 text-center">
          <div class="inline-flex items-center gap-1">
            <input type="number" min="0" value="${stockQty}" onchange="handleDirectStockInput('${prod.id}', this.value)" ${controlsDisabled} class="w-14 text-center bg-slate-50 border border-slate-200 rounded-lg py-1 font-mono font-extrabold text-xs text-slate-900 focus:bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 outline-none ${controlsOpacity}"/>
            <span class="text-[11px] text-slate-400 font-semibold">pcs</span>
          </div>
        </td>

        <!-- Status Badge -->
        <td class="py-3 px-3.5 whitespace-nowrap">
          ${badge}
        </td>

        <!-- Quick Restock Actions (+/-) & Delete -->
        <td class="py-3 px-3.5 text-right whitespace-nowrap">
          <div class="inline-flex items-center gap-1.5">
            <button type="button" onclick="handleAdjustStock('${prod.id}', -1)" ${controlsDisabled} class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center transition-all ${controlsOpacity}" title="Decrement -1">
              -
            </button>
            <button type="button" onclick="handleAdjustStock('${prod.id}', 1)" ${controlsDisabled} class="w-7 h-7 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center transition-all ${controlsOpacity}" title="Increment +1">
              +
            </button>
            <button type="button" onclick="handleAdjustStock('${prod.id}', 5)" ${controlsDisabled} class="px-2 h-7 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-[10px] font-bold flex items-center justify-center transition-all ${controlsOpacity}" title="Restock +5">
              +5
            </button>
            <button type="button" onclick="handleDeleteProduct('${prod.id}', '${escapeHtml(prod.name).replace(/'/g, "\\'")}')" ${controlsDisabled} class="w-7 h-7 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 flex items-center justify-center transition-all ${controlsOpacity}" title="Delete Product">
              <span class="material-symbols-outlined text-[15px]">delete</span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // 2. Mobile Cards Feed (Touch-Optimized for Phones)
  if (mobileList) {
    mobileList.innerHTML = filtered.map(prod => {
      const stockQty = typeof prod.stock === 'number' ? prod.stock : 0;
      const isOut = stockQty <= 0;
      const isLow = stockQty > 0 && stockQty <= 2;

      let badge = '';
      if (isOut) {
        badge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-rose-50 text-rose-700 border border-rose-200 inline-flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Out of Stock
        </span>`;
      } else if (isLow) {
        badge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Low (${stockQty})
        </span>`;
      } else {
        badge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${stockQty} in stock
        </span>`;
      }

      const priceFormatted = '₹' + parseFloat(prod.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const controlsDisabled = !currentStockAccess ? 'disabled title="Stock management access required"' : '';
      const controlsOpacity = !currentStockAccess ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer';

      return `
        <div class="bg-white rounded-2xl border p-3 shadow-2xs flex flex-col gap-2.5 ${isOut ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200/90'}">
          <div class="flex items-center gap-3">
            ${prod.image ? `<img src="${escapeHtml(prod.image)}" alt="" class="w-11 h-11 rounded-xl object-cover border border-slate-200 shrink-0" />` : `<div class="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-500 border border-indigo-100 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[20px]">checkroom</span></div>`}
            <div class="flex-1 min-w-0">
              <div class="font-bold text-slate-900 text-[13px] leading-snug truncate">${escapeHtml(prod.name)}</div>
              <div class="flex items-center gap-1.5 mt-0.5 min-w-0">
                <span class="font-mono text-[10.5px] font-bold text-indigo-600 shrink-0">#${escapeHtml(prod.sku || 'SKU')}</span>
                <span class="text-[10.5px] text-slate-400 truncate">· ${escapeHtml(prod.category || 'Standard')}</span>
              </div>
            </div>
            <span class="font-mono font-extrabold text-[13px] text-slate-900 shrink-0">${priceFormatted.replace(/\.00$/, '')}</span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">${badge}</div>
            <div class="inline-flex items-center gap-1 shrink-0">
              <button type="button" onclick="handleAdjustStock('${prod.id}', -1)" ${controlsDisabled} aria-label="Decrease stock" class="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 font-extrabold text-lg flex items-center justify-center active:scale-95 transition-all ${controlsOpacity}">−</button>
              <input type="number" inputmode="numeric" min="0" value="${stockQty}" onchange="handleDirectStockInput('${prod.id}', this.value)" ${controlsDisabled} aria-label="Stock quantity" class="w-12 h-10 text-center bg-white border border-slate-200 rounded-xl font-mono font-extrabold text-slate-900 focus:border-indigo-500 outline-none px-0 ${controlsOpacity}" />
              <button type="button" onclick="handleAdjustStock('${prod.id}', 1)" ${controlsDisabled} aria-label="Increase stock" class="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-700 font-extrabold text-lg flex items-center justify-center active:scale-95 transition-all ${controlsOpacity}">+</button>
              <button type="button" onclick="handleAdjustStock('${prod.id}', 5)" ${controlsDisabled} aria-label="Restock 5" class="px-2.5 h-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center justify-center active:scale-95 transition-all ${controlsOpacity}">+5</button>
              <button type="button" onclick="handleDeleteProduct('${prod.id}', '${escapeHtml(prod.name).replace(/'/g, "\\'")}')" ${controlsDisabled} aria-label="Delete product" class="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center active:scale-95 transition-all ${controlsOpacity}">
                <span class="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function filterStockTable() {
  const searchInput = document.getElementById('stockSearchInput');
  const catSelect = document.getElementById('stockCategoryFilter');
  if (searchInput) stockSearchQuery = searchInput.value;
  if (catSelect) stockFilterCategory = catSelect.value;
  renderStockCrmTable();
}

async function handleAdjustStock(productId, delta) {
  if (!currentStockAccess) {
    showToast('⚠️ Stock CRM access required. Contact store owner.');
    return;
  }
  try {
    const res = await fetch(`/api/products/${productId}/stock`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ delta })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`📦 Updated stock for "${data.product.name}" → ${data.product.stock} units`);
      await fetchProductCatalog();
      renderStockCrmTable();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to update stock'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  }
}

async function handleDirectStockInput(productId, newQty) {
  if (!currentStockAccess) {
    showToast('⚠️ Stock CRM access required. Contact store owner.');
    return;
  }
  const qty = parseInt(newQty, 10);
  if (isNaN(qty) || qty < 0) {
    showToast('⚠️ Invalid stock number');
    return;
  }
  try {
    const res = await fetch(`/api/products/${productId}/stock`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ stock: qty })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`📦 Stock set to ${data.product.stock} units`);
      await fetchProductCatalog();
      renderStockCrmTable();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to update stock'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  }
}

async function handleDeleteProduct(productId, productName) {
  if (!currentStockAccess) {
    showToast('⚠️ Stock CRM access required. Contact store owner.');
    return;
  }
  if (!confirm(`Are you sure you want to delete "${productName}" from the catalog?`)) {
    return;
  }
  try {
    const res = await fetch(`/api/products/${productId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🗑️ Deleted "${productName}"`);
      await fetchProductCatalog();
      renderStockCrmTable();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to delete product'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  }
}

function openAddProductModal() {
  const modal = document.getElementById('modalAddProduct');
  if (modal) {
    document.getElementById('newProdName').value = '';
    document.getElementById('newProdSku').value = '';
    document.getElementById('newProdPrice').value = '';
    document.getElementById('newProdStock').value = '5';
    document.getElementById('newProdNotes').value = '';
    if (typeof clearNewProductImage === 'function') clearNewProductImage();
    modal.classList.remove('hidden');
    document.getElementById('newProdName').focus();
  }
}

function closeAddProductModal() {
  const modal = document.getElementById('modalAddProduct');
  if (modal) modal.classList.add('hidden');
}

async function handleAddNewProductSubmit() {
  const name = document.getElementById('newProdName').value.trim();
  const sku = document.getElementById('newProdSku').value.trim();
  const price = document.getElementById('newProdPrice').value;
  const stock = document.getElementById('newProdStock').value;
  const category = document.getElementById('newProdCategory').value;
  const notes = document.getElementById('newProdNotes').value.trim();
  const image = document.getElementById('newProdImgData')?.value.trim() || document.getElementById('newProdImgUrl')?.value.trim() || '';

  if (!name || !price) {
    showToast('⚠️ Product name and price are required');
    return;
  }

  const btn = document.getElementById('btnSubmitAddProduct');
  const orig = btn.innerText;
  btn.disabled = true;
  btn.innerText = 'Adding Product...';

  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name,
        sku,
        price: parseFloat(price),
        stock: parseInt(stock, 10) || 0,
        category,
        notes,
        image
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🎉 "${data.product.name}" added to catalog with ${data.product.stock} units!`);
      closeAddProductModal();
      await fetchProductCatalog();
      renderStockCrmTable();
    } else {
      showToast('⚠️ ' + (data.error || 'Failed to add product'));
    }
  } catch (err) {
    console.error(err);
    showToast('⚠️ Server connection error');
  } finally {
    btn.disabled = false;
    btn.innerText = orig;
  }
}
