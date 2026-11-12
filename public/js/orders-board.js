/* Compact orders workspace. Server records remain the source of payment/fulfillment truth. */
(function () {
  'use strict';
  const terminal = order => ['CANCELLED', 'EXPIRED'].includes(order.status) || order.dispatchStatus === 'CANCELLED';
  const hasAddress = order => Boolean(order.address?.flat && order.address?.pincode);
  const needsReview = order => Boolean(order.fulfillmentIssue) || ['AWAITING_CONFIRMATION', 'REVIEW_REQUIRED', 'REFUND_REQUIRED'].includes(order.paymentStatus) || (!terminal(order) && order.status !== 'PAID' && Boolean(order.customerReportedUtr));
  const isPacking = order => !terminal(order) && order.status === 'PAID' && !order.fulfillmentIssue && hasAddress(order) && ['PENDING', 'PACKING', 'PACKED'].includes(order.dispatchStatus || 'PENDING');
  function matchesStatus(order, status) {
    if (status === 'REVIEW') return needsReview(order);
    if (status === 'PENDING') return !terminal(order) && order.status !== 'PAID';
    if (status === 'PAID') return order.status === 'PAID';
    if (status === 'READY') return isPacking(order) && order.dispatchStatus !== 'PACKED';
    if (status === 'PACKING') return isPacking(order);
    if (status === 'ADDRESS') return !terminal(order) && order.status === 'PAID' && !hasAddress(order);
    if (status === 'CANCELLED') return terminal(order);
    if (status === 'DISPATCHED') return !terminal(order) && order.status === 'PAID' && ['DISPATCHED', 'SHIPPED'].includes(order.dispatchStatus);
    if (status === 'DELIVERED') return order.status === 'PAID' && order.dispatchStatus === 'DELIVERED';
    return true;
  }
  function searchOrders(orders, query) {
    const words = String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return orders.filter(order => {
      const text = [order.ref, order.invoiceId, order.customerName, order.customerPhone, order.itemDescription, order.sku, order.trackingNumber, order.utr, order.customerReportedUtr, order.salesmanName, order.address?.city].join(' ').toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
  }
  // Pure helpers can also be checked without loading a browser or merchant data.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { matchesStatus, searchOrders, needsReview, isPacking };
    return;
  }

  const pageSize = 8;
  const state = { page: 1, filterKey: '', signature: '', drafts: new Map(), expanded: new Set(), busy: new Set() };
  let props;
  const byId = id => document.getElementById(id);
  const keyOf = order => String(order.token || order.id || order.ref);
  const money = order => Number(order.payableAmount ?? order.amount ?? 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const small = text => element('span', 'ob-secondary', text);
  const button = (text, handler, secondary = false) => {
    const node = element('button', `ob-button ${secondary ? 'ob-button-secondary' : 'ob-button-primary'}`, text);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  };
  function badge(text, tone = 'neutral') {
    return element('span', `ob-badge ob-badge-${tone}`, text);
  }
  function stack(...children) {
    const node = element('div', 'ob-stack');
    node.append(...children.filter(Boolean));
    return node;
  }
  function phone(order) {
    const digits = String(order.customerPhone || '').replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : (/^91\d{10}$/.test(digits) ? digits : '');
  }
  function checkoutUrl(order) {
    const url = new URL('/pay', location.origin);
    url.searchParams.set('token', order.token || '');
    return url.href;
  }
  function contactLink(order, message, text = 'WhatsApp') {
    if (!phone(order)) return null;
    const link = element('a', 'ob-contact', text);
    const url = new URL(`https://wa.me/${phone(order)}`);
    if (message) url.searchParams.set('text', message);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${text}: ${order.customerName || order.ref}`);
    return link;
  }
  function payment(order) {
    if (order.paymentStatus === 'REFUNDED') {
      const refNote = order.refundDetails?.reference ? ` · Ref ${order.refundDetails.reference}` : '';
      return { label: 'Refunded', tone: 'neutral', note: `${order.refundDetails?.method || 'Refund recorded'}${refNote}` };
    }
    if (order.paymentStatus === 'PARTIALLY_REFUNDED') {
      const amt = order.refundDetails?.amount !== undefined ? `₹${Number(order.refundDetails.amount).toFixed(2)} ` : '';
      return { label: 'Partial refund', tone: 'neutral', note: `${amt}refunded` };
    }
    if (order.paymentStatus === 'REFUND_REQUIRED') return { label: 'Refund review', tone: 'attention', note: 'Payment received · order cancelled' };
    if (order.fulfillmentIssue) return { label: 'Needs review', tone: 'attention', note: order.fulfillmentIssue === 'OUT_OF_STOCK' ? 'Payment / stock conflict' : 'Check order issue' };
    if (order.status === 'PAID') return { label: 'Received', tone: 'success', note: order.verifiedVia === 'admin_manual' ? 'Confirmed by owner' : 'Recorded by store' };
    if (['AWAITING_CONFIRMATION', 'REVIEW_REQUIRED'].includes(order.paymentStatus) || order.customerReportedUtr) return { label: 'Reported · unconfirmed', tone: 'attention', note: terminal(order) ? 'Closed order · check receipt' : 'Check receipt in your bank' };
    if (terminal(order)) return { label: order.status === 'EXPIRED' ? 'Expired' : 'Cancelled', tone: 'neutral', note: 'No payment confirmed' };
    return { label: 'Awaiting payment', tone: 'neutral', note: order.steps?.redirectedToPayment?.done ? 'UPI app opened · receipt pending' : 'No receipt confirmed' };
  }
  function delivery(order) {
    const status = order.dispatchStatus || 'PENDING';
    if (status === 'CANCELLED' || order.status === 'CANCELLED') return { label: 'Cancelled', tone: 'neutral' };
    if (order.status === 'EXPIRED') return { label: 'Checkout closed', tone: 'neutral' };
    if (order.fulfillmentIssue) return { label: 'On hold', tone: 'attention' };
    if (status === 'DELIVERED') return { label: 'Delivered', tone: 'success' };
    if (['DISPATCHED', 'SHIPPED'].includes(status)) return { label: 'Shipped', tone: 'info' };
    if (order.status !== 'PAID') return { label: 'Not ready to pack', tone: 'neutral' };
    if (!hasAddress(order)) return { label: 'Address needed', tone: 'attention' };
    return { label: status === 'PACKED' ? 'Packed' : status === 'PACKING' ? 'Packing' : 'Ready to pack', tone: 'info' };
  }
  function canManage(order) {
    return props.role === 'OWNER' || (props.role === 'SALESMAN' && props.staffId && order.salesmanId === props.staffId);
  }
  function getTracking(order) {
    return state.drafts.has(keyOf(order)) ? state.drafts.get(keyOf(order)) : String(order.trackingNumber || '');
  }
  function syncTracking(order) {
    const key = keyOf(order), value = getTracking(order), dirty = value !== String(order.trackingNumber || '');
    document.querySelectorAll('[data-ob-tracking]').forEach(input => { if (input.dataset.obTracking === key && input.value !== value) input.value = value; });
    document.querySelectorAll('[data-ob-draft]').forEach(note => { if (note.dataset.obDraft === key) note.textContent = dirty ? 'Unsaved tracking number' : ''; });
    document.querySelectorAll('[data-ob-save]').forEach(save => { if (save.dataset.obSave === key) save.disabled = !dirty || state.busy.has(key); });
    document.querySelectorAll('[data-ob-next]').forEach(action => { if (action.dataset.obNext === key) action.replaceWith(nextAction(order)); });
  }
  function revealDetails(order, focusTracking = false) {
    const key = keyOf(order);
    state.expanded.add(key);
    document.querySelectorAll('[data-ob-details]').forEach(details => {
      if (details.dataset.obDetails === key) {
        details.open = true;
        if (focusTracking && details.getClientRects().length) details.querySelector('input')?.focus();
      }
    });
  }
  async function runAction(order, action) {
    const key = keyOf(order);
    if (state.busy.has(key)) return;
    state.busy.add(key);
    state.signature = '';
    render(props);
    try { await action(); }
    catch (_) { window.showToast?.('Couldn’t save that change. Please try again.'); }
    finally { state.busy.delete(key); state.signature = ''; render(props); }
  }
  function actionFor(order) {
    const open = () => props.onOpen(order.ref);
    if (order.paymentStatus === 'REFUND_REQUIRED' && props.role === 'OWNER' && props.onRefund) {
      return { label: 'Record refund', run: () => runAction(order, () => props.onRefund(order.ref)) };
    }
    if (terminal(order) || order.fulfillmentIssue || !canManage(order)) return { label: needsReview(order) ? 'Review order' : 'View order', run: open };
    if (order.status !== 'PAID') return needsReview(order) && props.role === 'OWNER'
      ? { label: 'Review payment', run: () => runAction(order, () => props.onConfirm(order.ref)) }
      : { label: 'View order', run: open };
    if (!hasAddress(order)) {
      const message = `Hi ${order.customerName || 'there'}, payment for order ${order.ref} is recorded. Please add your delivery address here: ${checkoutUrl(order)}`;
      return phone(order) ? { label: 'Request address', href: contactLink(order, message).href } : { label: 'View order', run: open };
    }
    const status = order.dispatchStatus || 'PENDING';
    if (status === 'PENDING') return { label: 'Start packing', run: () => runAction(order, () => props.onDispatch(order.ref, 'PACKING')) };
    if (status === 'PACKING') return { label: 'Mark packed', run: () => runAction(order, () => props.onDispatch(order.ref, 'PACKED')) };
    if (status === 'PACKED') return getTracking(order).trim()
      ? { label: 'Mark shipped', run: () => runAction(order, () => props.onDispatch(order.ref, 'DISPATCHED')) }
      : { label: 'Add tracking', run: () => revealDetails(order, true) };
    if (['DISPATCHED', 'SHIPPED'].includes(status)) return { label: 'Mark delivered', run: () => runAction(order, () => props.onDispatch(order.ref, 'DELIVERED')) };
    return { label: 'View order', run: open };
  }
  function nextAction(order) {
    const action = actionFor(order);
    let node;
    if (action.href) {
      node = element('a', 'ob-button ob-button-primary', action.label);
      node.href = action.href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    } else node = button(action.label, action.run);
    node.dataset.obFocus = `${keyOf(order)}-action`;
    node.dataset.obNext = keyOf(order);
    node.setAttribute('aria-label', `${action.label} for order ${order.ref}`);
    if (state.busy.has(keyOf(order))) { node.disabled = true; node.textContent = 'Saving…'; }
    return node;
  }
  function detailsFor(order, mobile) {
    const key = keyOf(order);
    const details = element('details', 'ob-details');
    details.dataset.obDetails = key;
    details.open = state.expanded.has(key);
    const summary = element('summary', '', 'Details & tracking');
    summary.dataset.obFocus = `${key}-details-${mobile ? 'mobile' : 'desktop'}`;
    details.append(summary);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) state.expanded.add(key); else state.expanded.delete(key);
    });
    const body = element('div', 'ob-details-body');
    if (mobile) body.append(small('Item'), element('p', 'ob-detail-item', order.itemDescription || 'Order item'));
    const address = order.address;
    const addressText = address
      ? [address.fullName, address.flat, address.street, address.landmark, [address.city, address.state, address.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n')
      : 'Customer has not added a delivery address.';
    body.append(small('Delivery address'), element('p', 'ob-address', addressText));
    body.append(small(`Staff: ${order.salesmanName || 'Store owner'}`));
    if (order.utr || order.customerReportedUtr) body.append(small(`${order.status === 'PAID' ? 'Payment reference' : 'Reported reference'}: ${order.utr || order.customerReportedUtr}`));
    if (order.paymentMethod) body.append(small(order.paymentMethod));
    if (canManage(order) && order.status === 'PAID' && !terminal(order) && !order.fulfillmentIssue) {
      const label = element('label', 'ob-tracking-label', 'Courier tracking number');
      const input = element('input', 'ob-tracking-input');
      input.id = `${mobile ? 'mob_' : ''}trk_${order.ref}`;
      input.type = 'text'; input.maxLength = 150; input.autocomplete = 'off';
      input.placeholder = 'Enter AWB / tracking'; input.value = getTracking(order);
      input.dataset.obTracking = key;
      input.dataset.obFocus = `${key}-tracking-${mobile ? 'mobile' : 'desktop'}`;
      input.addEventListener('input', () => {
        // The legacy workspace retains tracking IDs too; clear its other hidden
        // copy before this input event reaches the shared draft listener.
        window.PaySapExperience?.clearTracking(order.ref);
        state.drafts.set(key, input.value);
        syncTracking(order);
      });
      label.append(input);
      const controls = element('div', 'ob-tracking-controls');
      const save = button('Save tracking', () => runAction(order, () => props.onSaveTracking(order.ref)), true);
      save.dataset.obSave = key;
      save.disabled = getTracking(order) === String(order.trackingNumber || '') || state.busy.has(key);
      const discard = button('Reset', () => {
        state.drafts.delete(key);
        window.PaySapExperience?.clearTracking(order.ref);
        syncTracking(order);
      }, true);
      discard.classList.add('ob-text-button');
      controls.append(save, discard);
      const note = element('span', 'ob-draft-note', getTracking(order) !== String(order.trackingNumber || '') ? 'Unsaved tracking number' : '');
      note.dataset.obDraft = key; note.setAttribute('aria-live', 'polite');
      body.append(label, controls, note);
    } else if (order.trackingNumber) body.append(small(`Tracking: ${order.trackingNumber}`));
    const links = element('div', 'ob-detail-links');
    links.append(button('Open order', () => props.onOpen(order.ref), true));
    const contact = contactLink(order);
    if (contact) links.append(contact);
    body.append(links);
    details.append(body);
    return details;
  }
  function desktopRow(order) {
    const row = element('tr', needsReview(order) ? 'ob-row-review' : '');
    const ref = button(order.ref || 'Order', () => props.onOpen(order.ref), true);
    ref.className = 'ob-reference';
    const date = new Date(order.createdAt);
    const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const customer = element('strong', 'ob-name', order.customerName || 'Customer');
    const phoneLink = contactLink(order, null, order.customerPhone || 'WhatsApp');
    const item = element('span', 'ob-item', order.itemDescription || 'Order item');
    item.title = order.itemDescription || '';
    const p = payment(order), d = delivery(order);
    const deliveryBlock = stack(badge(d.label, d.tone), small(order.address?.city || (hasAddress(order) ? 'Address saved' : '')), detailsFor(order, false));
    const cells = [stack(ref, small(dateText)), stack(customer, phoneLink || small('No phone saved')), stack(item, element('strong', 'ob-total', money(order))), stack(badge(p.label, p.tone), small(p.note)), deliveryBlock, nextAction(order)];
    cells.forEach(child => { const cell = element('td'); cell.append(child); row.append(cell); });
    return row;
  }
  function mobileCard(order) {
    const card = element('article', `ob-card ${needsReview(order) ? 'ob-card-review' : ''}`);
    const header = element('div', 'ob-card-header');
    const ref = element('span', 'ob-mobile-reference', order.ref || 'Order');
    const p = payment(order), d = delivery(order);
    header.append(ref, badge(p.label, p.tone));
    const item = element('p', 'ob-item', order.itemDescription || 'Order item');
    item.title = order.itemDescription || '';
    const itemRow = element('div', 'ob-card-item');
    itemRow.append(item, element('strong', 'ob-total', money(order)));
    const customer = element('div', 'ob-card-customer');
    customer.append(element('strong', 'ob-name', order.customerName || 'Customer'));
    customer.append(small(d.label));
    const footer = element('div', 'ob-card-footer');
    footer.append(detailsFor(order, true), nextAction(order));
    card.append(header, itemRow, customer, footer);
    return card;
  }
  function emptyState(filtered) {
    const empty = element('div', 'ob-empty');
    empty.append(element('span', 'material-symbols-outlined', filtered ? 'search_off' : 'receipt_long'));
    empty.append(element('h3', '', filtered ? 'No matching orders' : 'Your orders will appear here'));
    empty.append(element('p', '', filtered ? 'Try another name, reference or filter.' : 'Create a checkout link in New sale, then share it with your customer.'));
    if (filtered) empty.append(button('Clear search & filters', resetFilters, true));
    return empty;
  }
  function resetFilters() {
    if (byId('orderSearchInput')) byId('orderSearchInput').value = '';
    props.onStaff('ALL'); props.onSearch(''); props.onFilter('ALL');
    byId('orderSearchInput')?.focus();
  }
  function render(nextProps) {
    props = nextProps;
    const target = byId('masterDispatchTbody'), mobileTarget = byId('masterDispatchMobileList');
    if (!target || !mobileTarget) return;
    const filters = props.filters || {};
    const filterKey = JSON.stringify([filters.status, filters.staff, filters.query, props.role, props.staffId]);
    if (filterKey !== state.filterKey) { state.page = 1; state.filterKey = filterKey; }
    let orders = Array.isArray(props.orders) ? props.orders : [];
    // This is presentation scoping; APIs independently enforce authorization.
    if (props.role === 'SALESMAN') orders = props.staffId ? orders.filter(order => order.salesmanId === props.staffId) : [];
    const knownKeys = new Set(orders.map(keyOf));
    for (const key of state.drafts.keys()) if (!knownKeys.has(key)) state.drafts.delete(key);
    orders.forEach(order => {
      const key = keyOf(order);
      if (state.drafts.has(key) && state.drafts.get(key) === String(order.trackingNumber || '')) {
        state.drafts.delete(key); window.PaySapExperience?.clearTracking(order.ref);
      }
    });
    if (props.role === 'OWNER' && filters.staff && filters.staff !== 'ALL') orders = orders.filter(order => (order.salesmanId || 'OWNER') === filters.staff);
    const searched = searchOrders(orders, filters.query);
    const list = searched.filter(order => matchesStatus(order, filters.status || 'ALL'));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * pageSize;
    const visible = list.slice(start, start + pageSize);
    const signature = JSON.stringify([visible, state.page, filterKey, [...state.busy], list.length, orders.length, props.staff]);
    if (signature === state.signature) return;
    state.signature = signature;
    const active = document.activeElement;
    const focusKey = active?.dataset?.obFocus;
    const selection = active?.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;

    if (byId('ordersBoardHeading')) byId('ordersBoardHeading').textContent = props.role === 'SALESMAN' ? 'My orders' : 'Orders';
    if (byId('orderSearchInput')) byId('orderSearchInput').placeholder = 'Search orders';
    if (byId('ordersBoardCount')) byId('ordersBoardCount').textContent = list.length ? `${start + 1}–${Math.min(start + pageSize, list.length)} of ${list.length} orders` : '0 orders';
    const staffWrapper = byId('dispSalesmanFilterWrapper');
    if (staffWrapper) staffWrapper.hidden = props.role !== 'OWNER';
    const staffSelect = byId('dispSalesmanFilter');
    if (staffSelect && props.role === 'OWNER') {
      const all = element('option', '', 'All staff'); all.value = 'ALL';
      const owner = element('option', '', 'Store owner'); owner.value = 'OWNER';
      const options = (props.staff || []).filter(staff => staff.id && staff.id !== 'OWNER').map(staff => { const option = element('option', '', staff.name || 'Staff'); option.value = staff.id; return option; });
      staffSelect.replaceChildren(all, owner, ...options);
      staffSelect.value = filters.staff || 'ALL';
    }
    const chips = byId('ordersBoardFilters');
    if (chips) {
      const definitions = [['ALL', 'All'], ['REVIEW', 'Needs review'], ['PENDING', 'Awaiting payment'], ['PACKING', 'Packing queue'], ['DISPATCHED', 'Shipped'], ['DELIVERED', 'Delivered'], ['CANCELLED', 'Closed']];
      if (filters.status === 'PAID') definitions.push(['PAID', 'Payment received']);
      if (filters.status === 'ADDRESS') definitions.push(['ADDRESS', 'Address needed']);
      if (filters.status === 'READY') definitions.push(['READY', 'Ready to pack']);
      chips.replaceChildren(...definitions.map(([status, label]) => {
        const chip = button('', event => props.onFilter(status, event.currentTarget), true);
        chip.className = 'ob-filter disp-filter-btn'; chip.dataset.filter = status;
        chip.dataset.obFocus = `filter-${status}`;
        chip.setAttribute('aria-pressed', String((filters.status || 'ALL') === status));
        const count = searched.filter(order => matchesStatus(order, status)).length;
        const shortLabel = { REVIEW: 'Review', PENDING: 'Pending', PACKING: 'Packing' }[status] || label;
        chip.setAttribute('aria-label', `${label}, ${count} orders`);
        chip.append(element('span', 'ob-filter-label-full', label), element('span', 'ob-filter-label-short', shortLabel), element('span', 'ob-filter-count', String(count)));
        return chip;
      }));
    }
    if (visible.length) {
      target.replaceChildren(...visible.map(desktopRow));
      mobileTarget.replaceChildren(...visible.map(mobileCard));
    } else {
      const filtered = Boolean(filters.query || (filters.status && filters.status !== 'ALL') || (filters.staff && filters.staff !== 'ALL'));
      const row = element('tr'), cell = element('td'); cell.colSpan = 6;
      cell.append(emptyState(filtered)); row.append(cell); target.replaceChildren(row);
      mobileTarget.replaceChildren(emptyState(filtered));
    }
    const pagination = byId('ordersBoardPagination');
    if (pagination) {
      pagination.hidden = list.length <= pageSize;
      const previous = button('Previous', () => { state.page--; state.signature = ''; render(props); }, true);
      previous.disabled = state.page === 1; previous.setAttribute('aria-label', 'Previous page of orders'); previous.dataset.obFocus = 'previous-page';
      const next = button('Next', () => { state.page++; state.signature = ''; render(props); }, true);
      next.disabled = state.page === pages; next.setAttribute('aria-label', 'Next page of orders'); next.dataset.obFocus = 'next-page';
      pagination.replaceChildren(previous, small(`Page ${state.page} of ${pages}`), next);
    }
    if (focusKey) {
      const restored = [...document.querySelectorAll('[data-ob-focus]')].find(node => node.dataset.obFocus === focusKey && node.getClientRects().length);
      if (restored) { restored.focus({ preventScroll: true }); if (selection && restored.setSelectionRange) restored.setSelectionRange(...selection); }
    }
  }
  window.PaySapOrdersBoard = { render, resetFilters };
})();
