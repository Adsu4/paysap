/* Workspace behavior shared by desktop and mobile. No customer data leaves this origin. */
(function () {
  'use strict';
  const fieldIds = ['custPhone', 'custName', 'itemSku', 'itemDesc', 'orderValue', 'internalNotes', 'customerInstructions'];
  const byId = id => document.getElementById(id);
  let initialized = false;
  let restoringRoute = false;
  let created = null;
  let request = null;
  let lastOperationsSignature = '';
  let savedThemeId = 'lavender';
  let themePickerInitialized = false;
  let themeSaving = false;
  const trackingDrafts = new Map();
  const storage = {
    read(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; } },
    write(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
    remove(key) { try { sessionStorage.removeItem(key); } catch (_) {} }
  };
  const scope = () => `paysap_draft_v2_${currentSeller?.id || ''}_${currentSalesman?.id || 'owner'}`;
  const money = order => '₹' + Number(order.payableAmount ?? order.amount ?? order.price ?? 0).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const hasAddress = o => Boolean(o.address?.flat && o.address?.pincode);
  const isReview = o => ['AWAITING_CONFIRMATION', 'REVIEW_REQUIRED'].includes(o.paymentStatus) || Boolean(o.customerReportedUtr && o.status !== 'PAID');
  const isActive = o => !['CANCELLED', 'EXPIRED'].includes(o.status) && o.dispatchStatus !== 'CANCELLED';
  const isReady = o => o.status === 'PAID' && !o.fulfillmentIssue && hasAddress(o) && !['PACKED', 'DISPATCHED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(o.dispatchStatus);

  function setSync(state) {
    const el = byId('workspaceSyncState');
    if (!el) return;
    el.dataset.state = state;
    el.textContent = state === 'offline' ? 'Offline · reconnect to save changes' : state === 'error' ? 'Couldn’t refresh · showing last loaded orders' : 'Updated just now';
  }

  function persistDraft() {
    if (!initialized) return;
    const values = Object.fromEntries(fieldIds.map(id => [id, byId(id)?.value || '']));
    storage.write(scope(), {values, request, created, savedAt: Date.now()});
    const status = byId('draftStatus');
    if (status) status.textContent = created ? 'Link created. Open WhatsApp or copy it to share.' : 'Draft saved in this tab. Nothing has been sent to your customer.';
  }

  function init() {
    if (initialized) return;
    initialized = true;
    updateThemeSettings(currentSeller || {});
    const draft = storage.read(scope());
    if (draft && Date.now() - draft.savedAt < 24 * 60 * 60 * 1000) {
      fieldIds.forEach(id => { if (byId(id)) byId(id).value = draft.values?.[id] || ''; });
      request = draft.request || null;
      created = draft.created || null;
      if (created?.order) {
        activeRefNumber = created.order.ref;
        activeOrder = created.order;
        createdView(created);
      }
      if (byId('draftStatus')) byId('draftStatus').textContent = created ? 'Your created link is ready to share.' : 'Your draft was restored in this tab.';
    }
    const form = byId('linkGeneratorForm');
    form?.addEventListener('input', event => {
      if (event.target.id === 'productSearch') return;
      if (created) { created = null; activeRefNumber = null; activeOrder = null; }
      byId('createOrderError')?.classList.add('hidden');
      persistDraft();
      syncLivePitch();
    });
    form?.addEventListener('change', persistDraft);
    byId('productSearch')?.addEventListener('input', searchProducts);
    byId('productSearch')?.addEventListener('keydown', event => {
      if (event.key === 'Escape') { byId('catalogSearchResults').classList.add('hidden'); event.target.setAttribute('aria-expanded', 'false'); }
      if (event.key === 'ArrowDown') { event.preventDefault(); byId('catalogSearchResults')?.querySelector('button')?.focus(); }
    });
    byId('catalogSearchResults')?.addEventListener('click', event => {
      const button = event.target.closest('[data-product-index]');
      if (!button) return;
      const product = cachedProducts[Number(button.dataset.productIndex)];
      if (!product) return;
      created = null;
      activeRefNumber = null;
      handleCatalogSelect(product.sku || product.id);
      byId('productSearch').value = product.name;
      byId('productSearch').setAttribute('aria-expanded', 'false');
      byId('catalogSearchResults').classList.add('hidden');
      persistDraft();
      byId('itemDesc')?.focus();
    });
    byId('opsPriorityList')?.addEventListener('click', event => {
      const button = event.target.closest('[data-order-ref]');
      if (button) activateTab(button.dataset.orderRef);
    });
    document.addEventListener('input', event => {
      if (/^(mob_)?trk_/.test(event.target.id || '')) trackingDrafts.set(event.target.id, event.target.value);
    });
    initializeDialogs();
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab === 'studio') activateTab(new URLSearchParams(location.search).get('order') || 'NEW');
    else if (tab === 'dispatch' || (tab === 'inventory' && currentStockAccess) ||
      (currentRole === 'OWNER' && ['overview', 'settings'].includes(tab))) setMasterTab(tab);
    navigation(true);
    renderOperations();
    syncLivePitch();
  }

  function searchProducts() {
    const search = byId('productSearch');
    const results = byId('catalogSearchResults');
    const query = search.value.trim().toLocaleLowerCase();
    const matches = cachedProducts.map((p, index) => ({p, index})).filter(({p}) => `${p.name} ${p.sku || ''}`.toLocaleLowerCase().includes(query)).slice(0, 8);
    results.innerHTML = matches.length ? matches.map(({p, index}) => `<button type="button" data-product-index="${index}"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.sku || 'Custom SKU')} · ${money(p)} · ${typeof p.stock === 'number' ? (p.stock > 0 ? p.stock + ' available' : 'Out of stock') : 'Availability untracked'}</small></button>`).join('') : '<p class="p-4 text-sm text-slate-500">No matching products. Enter a custom item below.</p>';
    results.classList.remove('hidden');
    search.setAttribute('aria-expanded', 'true');
  }

  function customItem() {
    byId('productSearch').value = '';
    byId('itemSku').value = '';
    byId('catalogSelect').value = '';
    byId('catalogSearchResults').classList.add('hidden');
    byId('productSearch').setAttribute('aria-expanded', 'false');
    created = null;
    activeRefNumber = null;
    checkAndEnforceProductStock(null);
    byId('itemDesc')?.focus();
    persistDraft();
  }

  function renderOperations() {
    if (currentRole !== 'OWNER') return;
    const orders = cachedOrders.filter(isActive);
    const groups = {Review: orders.filter(isReview), Ready: orders.filter(isReady), Address: orders.filter(o => o.status === 'PAID' && !hasAddress(o)), Shipped: orders.filter(o => ['DISPATCHED', 'SHIPPED'].includes(o.dispatchStatus))};
    Object.entries(groups).forEach(([key, list]) => { if (byId('ops' + key + 'Count')) byId('ops' + key + 'Count').textContent = list.length; });
    const target = byId('opsPriorityList');
    if (!target) return;
    const priorities = [...groups.Review, ...groups.Address, ...groups.Ready].filter((o, i, all) => all.findIndex(other => other.id === o.id) === i).slice(0, 5);
    const signature = JSON.stringify(priorities.map(o => [o.id, o.ref, o.itemDescription, o.customerName, o.amount, o.payableAmount, o.paymentStatus, o.fulfillmentIssue, hasAddress(o)]));
    if (signature === lastOperationsSignature && target.childElementCount) return;
    lastOperationsSignature = signature;
    target.innerHTML = priorities.length ? priorities.map(o => `<div class="ops-list-row"><div><div class="ops-item">${escapeHtml(o.itemDescription)}</div><p>${escapeHtml(o.ref)} · ${escapeHtml(o.customerName || 'Customer')} · ${o.fulfillmentIssue ? 'Fulfillment needs review' : isReview(o) ? 'Payment reported · check bank receipt' : !hasAddress(o) ? 'Delivery details needed' : 'Ready to pack'}</p></div><span class="ops-price">${money(o)}</span><button type="button" class="secondary-action" data-order-ref="${escapeHtml(o.ref)}">${isReview(o) ? 'Review order' : 'View order'} <span aria-hidden="true">↗</span></button></div>`).join('') : `<div class="ops-empty"><span class="material-symbols-outlined" aria-hidden="true">${orders.length ? 'task_alt' : 'storefront'}</span><div><h3>${orders.length ? 'You’re all caught up' : 'Your first order starts here'}</h3><p>${orders.length ? 'No payments or packing tasks need your attention right now.' : 'Create a checkout link, share it with your customer, and follow the order here.'}</p></div></div>`;
  }

  function openQueue(kind) {
    dispFilterStatus = kind;
    window.orderSearchQuery = '';
    if (byId('orderSearchInput')) byId('orderSearchInput').value = '';
    setMasterTab('dispatch');
    document.querySelectorAll('.disp-filter-btn').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === kind)));
  }

  function matchesQueue(order, kind) {
    if (kind === 'REVIEW') return isActive(order) && (isReview(order) || Boolean(order.fulfillmentIssue));
    if (kind === 'READY') return isReady(order);
    if (kind === 'ADDRESS') return isActive(order) && order.status === 'PAID' && !hasAddress(order);
    if (kind === 'PENDING') return isActive(order) && order.status !== 'PAID';
    return true;
  }

  function navigation(replace = false) {
    const studio = currentMainView === 'STUDIO';
    document.querySelectorAll('#headerMasterNav button, #mobileBottomNav button').forEach(button => button.removeAttribute('aria-current'));
    const suffix = {overview: 'Overview', dispatch: 'Dispatch', inventory: 'Inventory', settings: 'Settings'}[currentMasterTab];
    [studio ? 'mTabBtnStudio' : 'mTabBtn' + suffix, studio ? null : 'mNavBtn' + suffix].filter(Boolean).forEach(id => byId(id)?.setAttribute('aria-current', 'page'));
    if (!initialized || restoringRoute) return;
    const url = new URL(location.href);
    url.searchParams.set('tab', studio ? 'studio' : currentMasterTab);
    if (studio && activeTab !== 'NEW') url.searchParams.set('order', activeTab); else url.searchParams.delete('order');
    if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState']({}, '', url);
  }
  window.addEventListener('popstate', () => {
    if (!initialized) return;
    restoringRoute = true;
    try {
      const params = new URLSearchParams(location.search);
      const tab = params.get('tab');
      if (tab === 'studio') activateTab(params.get('order') || 'NEW');
      else setMasterTab(['overview', 'dispatch', 'inventory', 'settings'].includes(tab) ? tab : currentRole === 'OWNER' ? 'overview' : 'dispatch');
    } finally { restoringRoute = false; }
  });

  function dispatchOptions(order) {
    const current = order.dispatchStatus || 'PENDING';
    const next = {PENDING: ['PACKING'], PACKING: ['PACKED', 'DISPATCHED'], PACKED: ['DISPATCHED'], DISPATCHED: ['DELIVERED'], DELIVERED: [], CANCELLED: []};
    const labels = {PENDING: 'Not prepared', PACKING: 'Preparing', PACKED: 'Packed', DISPATCHED: 'Shipped', DELIVERED: 'Delivered', CANCELLED: 'Cancelled'};
    return [current, ...(next[current] || [])].filter(value => value === current || (order.status === 'PAID' && (!['PACKED', 'DISPATCHED', 'DELIVERED'].includes(value) || hasAddress(order)))).map(value => `<option value="${value}" ${value === current ? 'selected' : ''}>${labels[value] || value}</option>`).join('');
  }

  function confirmPayment(order) {
    const dialog = byId('paymentConfirmationDialog');
    if (!dialog || !order) return Promise.resolve(null);
    byId('paymentConfirmationSummary').textContent = `${order.ref} · ${money(order)} · ${order.customerName || 'Customer'}`;
    const reference = byId('paymentConfirmationRef');
    reference.value = order.customerReportedUtr || '';
    reference.required = true;
    byId('paymentConfirmationMethod').value = 'Direct UPI · owner reviewed';
    byId('paymentConfirmationReason').value = '';
    byId('paymentConfirmationMethod').onchange = event => { reference.required = event.target.value !== 'Cash'; reference.disabled = event.target.value === 'Cash'; };
    reference.disabled = false;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? {
      paymentMethod: byId('paymentConfirmationMethod').value,
      utr: byId('paymentConfirmationMethod').value === 'Cash' ? '' : reference.value.trim(),
      reason: byId('paymentConfirmationReason').value.trim() || 'Owner checked receipt of the full amount'
    } : null), {once: true}));
  }

  function recordRefund(order) {
    const dialog = byId('refundResolutionDialog');
    if (!dialog || !order) return Promise.resolve(null);
    const paid = Number(order.payableAmount ?? order.amount ?? 0);
    byId('refundDialogSummary').textContent = `${order.ref} · Paid ${money(order)} · ${order.customerName || 'Customer'}`;
    const amountInput = byId('refundDialogAmount');
    amountInput.max = paid.toFixed(2);
    amountInput.value = paid.toFixed(2);
    byId('refundDialogMethod').value = 'UPI Refund';
    byId('refundDialogRef').value = '';
    byId('refundDialogNotes').value = '';
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? {
      amount: parseFloat(amountInput.value),
      method: byId('refundDialogMethod').value,
      reference: byId('refundDialogRef').value.trim(),
      notes: byId('refundDialogNotes').value.trim()
    } : null), {once: true}));
  }

  function renderReceipts(receipts) {
    const panel = byId('receiptReviewPanel');
    if (!panel) return;
    panel.classList.toggle('hidden', receipts.length === 0 || currentRole !== 'OWNER');
    const list = byId('receiptReviewList');
    const html = receipts.slice(0, 10).map(receipt => `<div class="ops-list-row"><div><div class="ops-item">${receipt.utr ? 'Reference ' + escapeHtml(receipt.utr) : 'Transaction reference missing'}</div><p>${receipt.authenticationVerified ? 'Sender authentication checked' : 'Sender authentication needs review'} · ${escapeHtml(new Date(receipt.receivedAt).toLocaleString('en-IN'))}</p></div><span class="ops-price">${money(receipt)}</span><button type="button" class="secondary-action" data-receipt-reference="${escapeHtml(receipt.utr || '')}">Find order</button></div>`).join('');
    if (list.innerHTML !== html) list.innerHTML = html;
    list.onclick = event => {
      const button = event.target.closest('[data-receipt-reference]');
      if (!button) return;
      openQueue('ALL');
      const query = button.dataset.receiptReference;
      if (byId('orderSearchInput')) byId('orderSearchInput').value = query;
      window.orderSearchQuery = query;
      renderMasterDispatchTable();
    };
  }

  function finalizeOrderDetails(order) {
    const closed = !isActive(order);
    const review = isReview(order) || Boolean(order.fulfillmentIssue);
    const pill = byId('cockpitStatusPill');
    if (pill && (closed || review)) { pill.textContent = order.paymentStatus === 'REFUND_REQUIRED' ? 'PAYMENT RECORDED · REFUND REQUIRED' : closed ? 'ORDER CLOSED' : 'PAYMENT REPORTED · REVIEW REQUIRED'; pill.classList.remove('animate-pulse'); }
    if (byId('cockpitLinkBadge')) byId('cockpitLinkBadge').textContent = closed ? 'Checkout closed' : 'Order link';
    if (closed) {
      if (byId('btnCockpitMarkPaid')) byId('btnCockpitMarkPaid').hidden = true;
      byId('step5Desc')?.querySelectorAll('button').forEach(button => button.hidden = true);
    }
    if (review) {
      if (byId('step5Title')) byId('step5Title').textContent = 'Awaiting review';
      if (byId('step5Desc')) byId('step5Desc').textContent = 'The store needs to check receipt of money and resolve any availability issue.';
      if (byId('cockpitRadarBanner')) byId('cockpitRadarBanner').hidden = true;
    } else if (byId('cockpitRadarBanner')) byId('cockpitRadarBanner').hidden = closed;
    if (!order.steps?.opened?.done) {
      if (byId('step2Title')) byId('step2Title').textContent = 'No checkout visit recorded';
      if (byId('step2Desc')) byId('step2Desc').textContent = 'A payment can be recorded without an observed visit.';
      if (byId('step2Time')) byId('step2Time').textContent = 'Not observed';
    }
    if (!order.steps?.redirectedToPayment?.done) {
      if (byId('step4Title')) byId('step4Title').textContent = 'No app handoff recorded';
      if (byId('step4Desc')) byId('step4Desc').textContent = 'Opening a UPI app is tracked separately from receiving payment.';
      if (byId('step4Time')) byId('step4Time').textContent = 'Not observed';
    }
    if (order.status === 'PAID' && !hasAddress(order)) {
      if (byId('step3Title')) byId('step3Title').textContent = 'Delivery details needed';
      if (byId('step3Desc')) byId('step3Desc').textContent = 'Payment is recorded. Get the delivery address before packing or shipping.';
      if (byId('step3Time')) byId('step3Time').textContent = 'Address not added';
    }
    if (byId('spreadsheetSyncStatusBadge')) byId('spreadsheetSyncStatusBadge').textContent = 'Saved order record';
  }

  function renderOrderReview(order) {
    const panel = byId('orderReviewNotice');
    if (!panel) return;
    const closed = !isActive(order);
    const refundRequired = order.paymentStatus === 'REFUND_REQUIRED';
    const refunded = order.paymentStatus === 'REFUNDED' || order.paymentStatus === 'PARTIALLY_REFUNDED';
    const review = isReview(order) || order.fulfillmentIssue;
    panel.classList.toggle('hidden', !review && !closed && currentRole !== 'OWNER');
    byId('orderReviewTitle').textContent = refunded
      ? (order.paymentStatus === 'PARTIALLY_REFUNDED' ? 'Partial refund recorded' : 'Refund recorded')
      : refundRequired ? 'Refund needs attention'
      : closed ? 'This order is closed'
      : review ? 'Check payment before fulfillment'
      : 'Order actions';
    if (refunded && order.refundDetails) {
      const refText = order.refundDetails.reference ? ` (Ref ${order.refundDetails.reference})` : '';
      byId('orderReviewText').textContent = `Refund of ₹${Number(order.refundDetails.amount || 0).toFixed(2)} via ${order.refundDetails.method || 'UPI Refund'}${refText} was logged.`;
    } else {
      byId('orderReviewText').textContent = refundRequired
        ? 'Payment was recorded before cancellation. Arrange the refund with the customer and record the bank/UPI refund reference here.'
        : closed ? 'Do not request another payment on this link. Contact the customer if money arrives after cancellation.'
        : order.fulfillmentIssue ? 'A payment or stock conflict needs your review. Check the bank record and resolve availability with the customer before confirming fulfillment.'
        : order.status === 'PAID' ? 'The store has recorded this payment. Check delivery details and fulfillment status before shipping.'
        : order.customerReportedUtr ? `The customer reported reference ${order.customerReportedUtr}. Check that ${money(order)} reached your account. A customer reference alone does not confirm payment.`
        : 'Only confirm money you actually received. Cancellation closes checkout; cancelling a paid order creates a refund task.';
    }
    const confirmButton = byId('reviewConfirmPayment');
    confirmButton.hidden = currentRole !== 'OWNER' || closed || order.status === 'PAID';
    confirmButton.onclick = () => window.manualMarkPaid(order.ref);
    const cancelButton = byId('reviewCancelOrder');
    cancelButton.hidden = currentRole !== 'OWNER' || closed || ['DISPATCHED', 'SHIPPED', 'DELIVERED'].includes(order.dispatchStatus);
    cancelButton.onclick = () => { if (confirm(`Cancel order ${order.ref}? The checkout will close. If money was received, you must arrange its refund separately.`)) updateDispatchStatus(order.ref, 'CANCELLED'); };
    const refundButton = byId('reviewRecordRefund');
    if (refundButton) {
      refundButton.hidden = currentRole !== 'OWNER' || !refundRequired;
      refundButton.onclick = () => window.recordOrderRefund?.(order.ref);
    }
  }

  function createdView(data) {
    created = data;
    fieldIds.forEach(id => { if (byId(id)) byId(id).disabled = true; });
    document.querySelectorAll('#linkGeneratorForm button, #linkGeneratorForm input[type=checkbox]').forEach(el => el.disabled = true);
    if (byId('productSearch')) byId('productSearch').disabled = true;
    activeRefNumber = data.order.ref;
    byId('preGenerateNotice')?.classList.add('hidden');
    byId('postGenerateActions')?.classList.remove('hidden');
    if (byId('postGenOrderRefTitle')) byId('postGenOrderRefTitle').textContent = `Order ${data.order.ref} is ready`;
    if (byId('postGenAmountTitle')) byId('postGenAmountTitle').textContent = money(data.order);
    persistDraft();
  }
  function resetDraft() {
    created = null;
    fieldIds.forEach(id => { if (byId(id)) byId(id).disabled = false; });
    document.querySelectorAll('#linkGeneratorForm button, #linkGeneratorForm input[type=checkbox]').forEach(el => el.disabled = false);
    if (byId('productSearch')) byId('productSearch').disabled = false;
    request = null;
    storage.remove(scope());
    if (byId('productSearch')) byId('productSearch').value = '';
    if (byId('customerInstructions')) byId('customerInstructions').value = '';
    if (byId('draftStatus')) byId('draftStatus').textContent = 'Your customer won’t receive anything until you share the link.';
    byId('createOrderError')?.classList.add('hidden');
  }
  function requestKey(payload) {
    const fingerprint = JSON.stringify(payload);
    if (!request || request.fingerprint !== fingerprint) request = {fingerprint, key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`};
    persistDraft();
    return request.key;
  }
  function showError(message) {
    const error = byId('createOrderError');
    if (error) { error.textContent = message; error.classList.remove('hidden'); error.focus(); }
  }
  function restoreTrackingDrafts() {
    trackingDrafts.forEach((value, id) => { if (byId(id)) byId(id).value = value; });
  }
  function clearTracking(ref) { trackingDrafts.delete('trk_' + ref); trackingDrafts.delete('mob_trk_' + ref); }
  function isEditing() {
    const element = document.activeElement;
    return element?.matches('input, textarea, select') && Boolean(element.closest('#mViewDispatch, #mViewInventory, #mViewSettings, #viewSaleDetail'));
  }

  function previewTheme(id) {
    const preset = window.PaySapTheme?.apply(id);
    if (!preset) return;
    if (byId('setThemeId')) byId('setThemeId').value = preset.id;
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === preset.id;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const changed = preset.id !== savedThemeId;
    if (byId('resetStoreTheme')) byId('resetStoreTheme').hidden = !changed;
    if (byId('saveStoreTheme')) byId('saveStoreTheme').disabled = themeSaving || !changed;
    if (byId('themePreviewStatus')) byId('themePreviewStatus').textContent = changed
      ? `Previewing ${preset.label}. Save to apply for customers.` : `${preset.label} is your saved palette.`;
  }

  function updateThemeSettings(settings) {
    if (!window.PaySapTheme) return;
    savedThemeId = PaySapTheme.resolve(settings.themeId || settings.brandColor).id;
    const grid = byId('themePresetGrid');
    if (grid && !themePickerInitialized) {
      themePickerInitialized = true;
      PaySapTheme.presets.forEach(preset => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'theme-preset';
        button.dataset.themeChoice = preset.id; button.setAttribute('role', 'radio');
        button.setAttribute('aria-label', preset.label);
        const sample = document.createElement('span'); sample.className = 'theme-preset-sample'; sample.setAttribute('aria-hidden', 'true');
        sample.style.background = preset.canvas; sample.style.borderColor = preset.border;
        const card = document.createElement('span'); card.style.background = preset.surface;
        const accent = document.createElement('span'); accent.style.background = preset.primary;
        card.append(accent); sample.append(card);
        const label = document.createElement('span'); label.textContent = preset.label;
        const check = document.createElement('span'); check.className = 'theme-preset-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
        button.append(sample, label, check);
        button.addEventListener('click', () => previewTheme(preset.id));
        button.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...grid.querySelectorAll('[data-theme-choice]')];
          let index = buttons.indexOf(button);
          index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
          buttons[index].click(); buttons[index].focus();
        });
        grid.append(button);
      });
      byId('resetStoreTheme')?.addEventListener('click', () => previewTheme(savedThemeId));
      byId('saveStoreTheme')?.addEventListener('click', saveTheme);
    }
    previewTheme(savedThemeId);
  }

  async function saveTheme() {
    if (currentRole !== 'OWNER' || themeSaving) return;
    const button = byId('saveStoreTheme');
    const id = byId('setThemeId')?.value;
    if (!window.PaySapTheme?.isValidId(id)) return;
    themeSaving = true;
    document.querySelectorAll('[data-theme-choice], #resetStoreTheme').forEach(control => { control.disabled = true; });
    button.disabled = true; button.textContent = 'Saving…';
    try {
      const response = await fetch('/api/store/settings', {method: 'PUT', headers: getAuthHeaders({'Content-Type': 'application/json'}), body: JSON.stringify({themeId: id})});
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not save the colour. Try again.');
      savedThemeId = id;
      currentSeller.themeId = id;
      currentSeller.brandColor = PaySapTheme.resolve(id).primary;
      previewTheme(id);
      showToast('Store colour saved. Customer checkout now uses this palette.');
    } catch (error) {
      byId('themePreviewStatus').textContent = error.message || 'Could not save the colour. Try again.';
      button.disabled = false;
    } finally {
      themeSaving = false;
      document.querySelectorAll('[data-theme-choice], #resetStoreTheme').forEach(control => { control.disabled = false; });
      button.disabled = byId('setThemeId')?.value === savedThemeId;
      button.textContent = 'Save colour';
    }
  }

  function initializeDialogs() {
    document.querySelectorAll('[id$="Modal"], [id^="modal"], #qrModal').forEach(modal => {
      if (!modal.classList.contains('fixed')) return;
      const heading = modal.querySelector('h2, h3, .font-bold, .font-extrabold');
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', heading?.textContent?.trim() || 'Dialog');
      let previouslyFocused;
      const observer = new MutationObserver(() => {
        if (modal.classList.contains('hidden')) { if (previouslyFocused?.isConnected) previouslyFocused.focus(); previouslyFocused = null; return; }
        if (!previouslyFocused) { previouslyFocused = document.activeElement; modal.querySelector('input:not([type="hidden"]), button, select, textarea')?.focus(); }
      });
      observer.observe(modal, {attributes: true, attributeFilter: ['class']});
      modal.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const fields = [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
        const first = fields[0], last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
    });
  }

  window.PaySapExperience = {init, updateThemeSettings, setSync, persistDraft, customItem, dispatchOptions, confirmPayment, recordRefund, finalizeOrderDetails, renderOrderReview, renderReceipts, renderOperations, openQueue, matchesQueue, navigation, createdView, resetDraft, requestKey, showError, restoreTrackingDrafts, clearTracking, isEditing, getCreated: () => created, clearSession: () => { storage.remove(scope()); }};
})();
