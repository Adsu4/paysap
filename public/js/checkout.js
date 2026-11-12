// The server is the authority for customer payment and fulfillment state.
document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const orderToken = params.get('token') || params.get('ref') || '';
  const endpoint = `/api/orders/${encodeURIComponent(orderToken)}`;
  const sessionName = `paysap_session_${orderToken}`;
  const screenIds = ['loadingCard', 'errorCard', 'beatAddressCard', 'beatPaymentCard', 'beatSuccessCard', 'beatOutOfStockCard'];
  const addressFields = { fullName: 'addrFullName', phone: 'addrPhone', flat: 'addrFlat', street: 'addrStreet', landmark: 'addrLandmark', pincode: 'addrPincode', city: 'addrCity', state: 'addrState' };
  const deviceQuery = window.matchMedia('(max-width: 767px)');
  const narrowQuery = window.matchMedia('(max-width: 359px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentOrder = null;
  let customerSessionKey = '';
  let pollTimer = null;
  let pollingStartedAt = 0;
  let pollInFlight = false;
  let loadInFlight = false;
  let hasLaunchedUpi = false;
  let reportPending = false;
  let toastTimer = null;
  let pincodeTimer = null;
  let screen = 'loadingCard';
  let lastCityLookup = '';
  let lastStateLookup = '';
  let pincodeController = null;
  let addressStep = 'contact';
  try { customerSessionKey = sessionStorage.getItem(sessionName) || ''; } catch { /* Keep session in memory if storage is unavailable. */ }

  function headers(extra = {}) { return { ...extra, ...(customerSessionKey ? { 'X-Order-Session': customerSessionKey } : {}) }; }
  function money(amount) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(amount) || 0); }
  function orderRef(order = currentOrder) { return String(order?.storeRef || order?.ref || order?.token || ''); }
  function text(id, value) { if ($(id)) $(id).textContent = value ?? ''; }
  function show(id, visible = true) { if ($(id)) $(id).hidden = !visible; }
  function announce(message) { text('toast', message); show('toast'); clearTimeout(toastTimer); toastTimer = setTimeout(() => show('toast', false), 4000); }

  function setScreen(next, focus = false) {
    screen = next;
    screenIds.forEach(id => show(id, id === next));
    const stage = next === 'beatAddressCard' ? 'stepDelivery' : next === 'beatPaymentCard' ? 'stepPayment' : next === 'beatSuccessCard' ? 'stepComplete' : '';
    show('orderSummary', next === 'beatAddressCard' || next === 'beatPaymentCard');
    show('checkoutProgress', Boolean(stage));
    ['stepDelivery', 'stepPayment', 'stepComplete'].forEach(id => {
      if (id === stage) $(id).setAttribute('aria-current', 'step');
      else $(id).removeAttribute('aria-current');
    });
    if (focus) {
      $(next).querySelector('h1,h2')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }

  function showError(title, message, retry = true) {
    stopPolling(); text('errorTitle', title); text('errorMsg', message); show('btnRetryOrder', retry); setScreen('errorCard', true);
  }

  function supportUrl(order = currentOrder) {
    const raw = String(order?.storePhone || order?.sellerPhone || '');
    if (/[*•]/.test(raw)) return '';
    let phone = raw.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;
    if (!/^91[6-9]\d{9}$/.test(phone)) return '';
    const message = `Hi ${order.brandName || 'there'}, I need help with order #${orderRef(order)}${order.itemDescription ? ` (${order.itemDescription})` : ''}.`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  }

  function populateSupport(order) {
    const url = supportUrl(order);
    ['storeSupportLink', 'btnOosWhatsApp', 'btnConfirmWhatsApp'].forEach(id => {
      show(id, Boolean(url));
      if (url) $(id).href = url;
      else $(id).removeAttribute('href');
    });
    $('storeSupport').classList.toggle('contact-available', Boolean(url));
    text('supportHint', url ? 'Questions about payment or delivery? Ask the store.' : 'Return to the conversation where you received this link.');
  }

  function safeImage(value) {
    if (!value) return '';
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value)) return value;
    try { const url = new URL(value, location.origin); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }

  function populateBrand(order) {
    window.PaySapTheme?.apply(order.themeId || order.brandColor);
    text('ambientBrandName', order.brandName || 'Store checkout');
    text('merchantInfoName', order.brandName || 'Store');
    document.title = `${order.status === 'PAID' ? 'Order' : 'Pay ' + money(order.payableAmount ?? order.amount)} · ${order.brandName || 'Store checkout'}`;
    const logo = safeImage(order.storeLogo || order.brandLogo);
    if (logo) { $('storeLogoImg').src = logo; show('storeLogoImg'); show('storeLogoFallback', false); }
    else { show('storeLogoImg', false); show('storeLogoFallback'); }
    const handle = String(order.storeInstagram || '').replace(/^@/, '');
    const validHandle = /^[a-zA-Z0-9_.]{1,30}$/.test(handle);
    show('merchantInfo', Boolean(order.storeLocation || validHandle));
    ['', 'Beat2'].forEach(suffix => {
      text('storeLocationText' + suffix, order.storeLocation || ''); show('storeLocationText' + suffix, Boolean(order.storeLocation));
      const link = $('storeInstaLink' + suffix); show('storeInstaLink' + suffix, validHandle);
      if (validHandle && link) { link.href = `https://www.instagram.com/${encodeURIComponent(handle)}/`; link.textContent = '@' + handle; }
      show('storeBrandingBadge' + suffix, Boolean(order.storeLocation || validHandle));
    });
    populateSupport(order);
  }

  function addressText(address) {
    if (!address) return 'Delivery details have not been added yet.';
    return [address.fullName, address.phone, address.flat, address.street, address.landmark, address.city, [address.state, address.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }
  function addressMasked(order) { return order.addressMasked === true || /[*•]/.test([order.address?.fullName, order.address?.phone, order.address?.flat, order.customerName, order.customerPhone].filter(Boolean).join(' ')); }
  function hasAddress(order) { return Boolean(order.address && order.address.flat && order.address.pincode); }

  function populateOrder(order, fillAddress = false) {
    populateBrand(order);
    const total = money(order.payableAmount ?? order.amount);
    text('billItemDesc', order.itemDescription || 'Order item'); text('reviewItemDesc', order.itemDescription || 'Order item'); text('reviewBrandName', order.brandName || 'Store');
    text('billRefNumber', `Order #${orderRef(order)}`); text('billTotalAmount', total); text('reviewTotalAmount', total);
    text('billSkuBadge', order.sku ? `SKU ${order.sku}` : ''); show('billSkuBadge', Boolean(order.sku));
    const breakdownEl = $('billItemBreakdown');
    const items = Array.isArray(order.items) ? order.items : [];
    const discount = Number(order.discountAmount || 0);
    const shipping = Number(order.shippingAmount || 0);
    if (breakdownEl) {
      breakdownEl.innerHTML = '';
      if (items.length > 1 || discount > 0 || shipping > 0 || (items[0] && Number(items[0].quantity) > 1)) {
        items.forEach(item => {
          const row = document.createElement('div');
          row.className = 'item-breakdown-row';
          const left = document.createElement('span');
          left.textContent = `${item.name || 'Item'} × ${Number(item.quantity) || 1}`;
          const right = document.createElement('strong');
          right.textContent = money((Number(item.unitPrice) || 0) * (Number(item.quantity) || 1));
          row.appendChild(left);
          row.appendChild(right);
          breakdownEl.appendChild(row);
        });
        if (shipping > 0) {
          const row = document.createElement('div');
          row.className = 'item-breakdown-row';
          const left = document.createElement('span'); left.textContent = 'Shipping';
          const right = document.createElement('strong'); right.textContent = money(shipping);
          row.appendChild(left); row.appendChild(right); breakdownEl.appendChild(row);
        }
        if (discount > 0) {
          const row = document.createElement('div');
          row.className = 'item-breakdown-row';
          const left = document.createElement('span'); left.textContent = 'Discount';
          const right = document.createElement('strong'); right.textContent = '−' + money(discount);
          row.appendChild(left); row.appendChild(right); breakdownEl.appendChild(row);
        }
        show('billItemBreakdown', true);
      } else {
        show('billItemBreakdown', false);
      }
    }
    const image = safeImage(order.productImage);
    if (image) { $('billProductImg').src = image; $('billProductImg').alt = order.itemDescription || 'Order item'; }
    show('billProductImg', Boolean(image));
    text('billNotes', order.customerInstructions || ''); show('billNotesRow', Boolean(order.customerInstructions));
    const difference = Math.round((Number(order.payableAmount ?? order.amount) - Number(order.amount)) * 100) / 100;
    ['amountAdjustment', 'paymentAmountAdjustment'].forEach(id => {
      text(id, `${money(order.amount)} + ${money(difference)} payment matching adjustment. Please pay the exact total.`); show(id, difference > 0);
    });
    const masked = addressMasked(order);
    text('summaryDeliveryText', masked && hasAddress(order) ? `Delivery details saved${order.address?.city ? ' · ' + order.address.city : ''}${order.address?.pincode ? ' ' + order.address.pincode : ''}` : addressText(order.address));
    text('deliverySummaryShort', hasAddress(order) ? `Delivery${!masked && order.address.fullName ? ' to ' + order.address.fullName.split(' ')[0] : ''}${order.address.city ? ' · ' + order.address.city : ''}` : 'Add delivery details');
    show('addressPrivacyHint', masked && hasAddress(order));
    const frozen = ['PACKED', 'DISPATCHED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(order.dispatchStatus);
    show('btnEditAddress', !frozen && !(masked && hasAddress(order)));
    if (fillAddress && !masked) {
      const address = order.address || { fullName: order.customerName || '', phone: order.customerPhone || '' };
      Object.entries(addressFields).forEach(([key, id]) => { $(id).value = address[key] || ''; });
    }
    setupPayment(order);
  }

  function setupPayment(order) {
    const vpa = String(order.upiId || ''); const ref = `REF${order.ref || orderRef(order)}`;
    ['displayVpa', 'displayVpaMobile'].forEach(id => text(id, vpa)); ['displayRefNote', 'displayRefNoteMobile'].forEach(id => text(id, ref));
    const validVpa = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(vpa); const amount = Number(order.payableAmount ?? order.amount);
    // Build from known fields instead of navigating to arbitrary stored URL input.
    const upi = `upi://pay?${new URLSearchParams({ pa: vpa, pn: order.brandName || 'Store', am: amount.toFixed(2), cu: 'INR', tn: ref, tr: String(order.ref || orderRef(order)) })}`;
    ['btnPayUpiIntent', 'btnPayUpiIntentDesktop'].forEach(id => {
      if (validVpa && amount > 0) { $(id).href = upi; $(id).removeAttribute('aria-disabled'); }
      else { $(id).removeAttribute('href'); $(id).setAttribute('aria-disabled', 'true'); }
    });
    text('btnPayUpiIntent', `Pay ${money(amount)} via UPI ↗`);
    try {
      if (!validVpa || !(amount > 0)) throw new Error('Payment details unavailable');
      const svg = window.QRCode.generateSvg(upi, { colorDark: '#182135', colorLight: '#ffffff', margin: 4 });
      $('qrSvgWrapper').innerHTML = svg; $('qrSvgWrapperMobile').innerHTML = svg;
    } catch { ['qrSvgWrapper', 'qrSvgWrapperMobile'].forEach(id => text(id, 'QR unavailable. Contact the store for help.')); }
    applyDeviceLayout();
  }

  function applyDeviceLayout() {
    const phone = deviceQuery.matches || /Android|iPhone|iPod/i.test(navigator.userAgent);
    show('mobilePayHero', phone); show('mobileQrToggle', phone); show('desktopQrHero', !phone); show('desktopPayLink', !phone);
  }

  // At narrow widths, two short delivery steps keep controls readable and the action discoverable.
  // Wider phones keep the complete compact form; changing width preserves all entered values.
  function syncAddressStep(step = addressStep, focus = false) {
    addressStep = step;
    const narrow = narrowQuery.matches;
    $('addressFields').dataset.addressStep = narrow ? step : 'all';
    $('addressFields').querySelectorAll('.contact-step input,.location-step input').forEach(input => {
      const field = input.closest('.field');
      input.disabled = narrow && !(field.classList.contains(step === 'contact' ? 'contact-step' : 'location-step'));
    });
    show('addressSubstepLabel', narrow);
    text('addressSubstepLabel', step === 'contact' ? '· 1 of 2' : '· 2 of 2');
    show('btnAddressNext', narrow && step === 'contact');
    show('btnAddressBack', narrow && step === 'location');
    show('btnContinueToPayment', !narrow || step === 'location');
    if (focus) {
      $('addressTitle').focus({ preventScroll: true });
      $('addressTitle').scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }
  function setPaymentStatus(title, message, review = false) {
    text('paymentStatusTitle', title); text('bankConfirmIndicator', message); $('paymentStatusPanel').classList.toggle('notice-review', review);
  }
  function refreshPendingState(order) {
    const review = order.paymentStatus === 'REVIEW_REQUIRED' || Boolean(order.fulfillmentIssue);
    reportPending = order.paymentStatus === 'AWAITING_CONFIRMATION' || Boolean(order.customerReportedUtr) || review;
    show('paymentMethods', !reportPending);
    if (review) setPaymentStatus('The store needs to review this order', 'A payment or stock issue needs the store’s attention. Please don’t pay again. Contact the store to confirm the next step.', true);
    else if (reportPending) setPaymentStatus('Your payment is being checked', 'Your reference has been submitted. Please don’t pay again while the store checks receipt of money.', true);
    else if (!order.upiId || !(Number(order.payableAmount ?? order.amount) > 0)) setPaymentStatus('Payment details unavailable', 'Please contact the store before paying.');
    else if (hasLaunchedUpi) setPaymentStatus('Waiting for payment confirmation', 'If you completed the payment, keep this page open or check again later. Please don’t pay again while confirmation is pending.');
    else setPaymentStatus('Ready when you are', 'This page checks for the store’s payment confirmation.');
  }

  function applyOrderState(order, initial = false) {
    currentOrder = order; populateBrand(order);
    if (order.status === 'PAID') { showSuccessReceipt(order, !initial); return; }
    if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
      showError(order.status === 'CANCELLED' ? 'This order was cancelled' : 'This order link has expired', 'Please contact the store for a new link. If money has already left your account, don’t pay again; ask the store to check it.', false); return;
    }
    const needsReview = order.paymentStatus === 'REVIEW_REQUIRED' || Boolean(order.fulfillmentIssue);
    if ((order.isOutOfStock || order.status === 'OUT_OF_STOCK') && !needsReview) {
      stopPolling(); text('oosItemName', order.itemDescription || 'Your item'); text('oosOrderRef', `Order #${orderRef(order)}`); setScreen('beatOutOfStockCard', !initial); return;
    }
    if (initial || needsReview && screen !== 'beatPaymentCard') { populateOrder(order, initial); setScreen(needsReview || hasAddress(order) ? 'beatPaymentCard' : 'beatAddressCard'); }
    refreshPendingState(order);
  }

  async function request(url, options = {}) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try { return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit' }); }
    finally { clearTimeout(timeout); }
  }
  async function loadOrder() {
    if (loadInFlight) return;
    if (!orderToken) { showError('This link is incomplete', 'Please open the full order link shared by the store in your conversation.', false); return; }
    loadInFlight = true; setScreen('loadingCard');
    try {
      const response = await request(endpoint, { headers: headers() });
      if (response.status === 404 || response.status === 403) { showError('We couldn’t find this order', 'Please use the latest link shared by the store, or ask the store for a new one.', false); return; }
      if (!response.ok) throw new Error('Unable to load order');
      applyOrderState(await response.json(), true);
      if (['beatAddressCard', 'beatPaymentCard'].includes(screen)) startPolling();
    } catch { showError('We couldn’t load this order', 'Check your connection and try again. If you already paid, don’t pay again while the store checks your payment.'); }
    finally { loadInFlight = false; }
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll() {
    stopPolling(); if (!['beatAddressCard', 'beatPaymentCard'].includes(screen)) return;
    if (Date.now() - pollingStartedAt >= 10 * 60 * 1000) { setPaymentStatus('Automatic checks paused', 'You can check the payment status again below. If you already paid, please don’t pay again.'); return; }
    pollTimer = setTimeout(() => checkPayment(false), document.hidden ? 30000 : 5000);
  }
  function startPolling() { pollingStartedAt = Date.now(); schedulePoll(); }
  async function checkPayment(manual = false) {
    if (pollInFlight || !currentOrder || currentOrder.status === 'PAID') return;
    pollInFlight = true;
    if (manual) { $('btnCheckPayment').disabled = true; text('btnCheckPayment', 'Checking…'); pollingStartedAt = Date.now(); }
    try {
      const response = await request(endpoint + '?track=false', { headers: headers() });
      if ([403, 404, 410].includes(response.status)) { showError('This order is unavailable', 'Please contact the store for help. If you already paid, don’t pay again.', false); return; }
      if (!response.ok) throw new Error('Status check failed');
      applyOrderState(await response.json());
      text('lastChecked', `Last checked ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`); show('lastChecked');
      if (manual && currentOrder.status !== 'PAID') announce(reportPending ? 'The store is still checking your payment.' : 'No payment confirmation yet.');
    } catch { setPaymentStatus(navigator.onLine ? 'We couldn’t check just now' : 'You’re offline', 'Reconnect and use “Check status”. If you already paid, don’t pay again.'); }
    finally { pollInFlight = false; $('btnCheckPayment').disabled = false; text('btnCheckPayment', 'Check status'); schedulePoll(); }
  }

  function openReferenceForm() {
    const visible = $('utrDrawer').hidden; show('utrDrawer', visible); $('btnOpenUtrEarly').setAttribute('aria-expanded', String(visible)); text('btnOpenUtrEarly', visible ? 'Hide' : 'Add reference');
    if (visible) { $('utrInput').focus(); $('utrDrawer').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' }); }
  }
  async function submitReference(event) {
    event.preventDefault(); if (!$('utrDrawer').reportValidity()) return;
    const button = $('btnSubmitUtr'); button.disabled = true; text('btnSubmitUtr', 'Submitting…'); text('utrStatus', 'Sending the reference to the store…');
    try {
      const response = await request(endpoint + '/utr', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ utr: $('utrInput').value.trim() }) }); const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'The reference couldn’t be submitted. Please try again.');
      // A successful report (202) is not proof of payment. Only an authoritative PAID order confirms it.
      if (result.order?.status === 'PAID') { applyOrderState(result.order); return; }
      if (result.order) currentOrder = { ...currentOrder, ...result.order };
      if (currentOrder.paymentStatus !== 'REVIEW_REQUIRED') currentOrder.paymentStatus = 'AWAITING_CONFIRMATION';
      reportPending = true; refreshPendingState(currentOrder); text('utrStatus', 'Reference received. The store is checking your payment. Please don’t pay again.'); startPolling();
    } catch (error) { text('utrStatus', error.name === 'AbortError' ? 'The request timed out. Check the status before submitting again.' : error.message || 'Connection lost. Check the status before submitting again.'); }
    finally { button.disabled = false; text('btnSubmitUtr', 'Submit reference'); }
  }
  async function saveAddress(event) {
    event.preventDefault(); const form = $('addressForm'); if (!form.reportValidity()) return;
    show('addressError', false); const button = $('btnContinueToPayment'); button.disabled = true; button.textContent = 'Saving delivery details…';
    const address = Object.fromEntries(Object.entries(addressFields).map(([key, id]) => [key, $(id).value.trim()]));
    try {
      const response = await request(endpoint + '/address', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(address) }); const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Your delivery details couldn’t be saved. Please try again.');
      if (result.customerSessionKey) { customerSessionKey = result.customerSessionKey; try { sessionStorage.setItem(sessionName, customerSessionKey); } catch { /* Keep session in memory. */ } }
      currentOrder = { ...currentOrder, ...(result.order || {}), address, customerName: address.fullName, customerPhone: address.phone, addressMasked: false };
      if (['PAID', 'CANCELLED', 'EXPIRED', 'OUT_OF_STOCK'].includes(currentOrder.status) || currentOrder.isOutOfStock) { applyOrderState(currentOrder); return; }
      populateOrder(currentOrder); refreshPendingState(currentOrder); setScreen('beatPaymentCard', true); startPolling();
    } catch (error) { text('addressError', error.name === 'AbortError' ? 'The request timed out. Your details are still here; please try again.' : error.message || 'We couldn’t save your details. Check your connection and try again.'); show('addressError'); }
    finally { button.disabled = false; button.textContent = 'Continue to payment →'; }
  }
  async function lookupPincode(code) {
    pincodeController?.abort(); const controller = new AbortController(); pincodeController = controller; text('pincodeStatus', 'Looking up city and state…');
    try {
      const response = await fetch(`/api/pincode/${code}`, { signal: controller.signal, credentials: 'omit' }); const result = await response.json();
      if ($('addrPincode').value !== code) return;
      if (!response.ok || !result.success || !result.data) throw new Error('Lookup unavailable');
      // Preserve deliberate customer corrections and ignore stale lookup results.
      if (!$('addrCity').value || $('addrCity').value === lastCityLookup) { $('addrCity').value = result.data.city || ''; lastCityLookup = $('addrCity').value; }
      if (!$('addrState').value || $('addrState').value === lastStateLookup) { $('addrState').value = result.data.state || ''; lastStateLookup = $('addrState').value; }
      text('pincodeStatus', 'Check the city and state before continuing.');
    } catch (error) { if (error.name !== 'AbortError' && $('addrPincode').value === code) text('pincodeStatus', 'Enter your city and state below. You can continue without the lookup.'); }
  }
  function showSuccessReceipt(order, focus) {
    stopPolling();
    const refundRequired = order.paymentStatus === 'REFUND_REQUIRED' || (order.dispatchStatus === 'CANCELLED' && order.paymentStatus !== 'REFUNDED' && order.paymentStatus !== 'PARTIALLY_REFUNDED');
    const refunded = order.paymentStatus === 'REFUNDED' || order.paymentStatus === 'PARTIALLY_REFUNDED';
    const refundInfo = order.refundDetails && typeof order.refundDetails === 'object' ? order.refundDetails : null;
    if (refunded) {
      text('receiptEyebrow', order.paymentStatus === 'PARTIALLY_REFUNDED' ? 'Partial refund recorded' : 'Refund recorded');
      text('successTitle', 'Refund has been processed.');
      const refSuffix = refundInfo?.reference ? ` (Ref: ${refundInfo.reference})` : '';
      text('receiptMessage', `The store recorded a ${money(refundInfo?.amount ?? order.payableAmount ?? order.amount)} refund via ${refundInfo?.method || 'bank/UPI'}${refSuffix}.`);
    } else if (refundRequired) {
      text('receiptEyebrow', 'Payment recorded · refund needs attention');
      text('successTitle', 'This order has been cancelled.');
      text('receiptMessage', 'Your payment is recorded, but the order was cancelled. Please contact the store to arrange or check your refund.');
    } else {
      text('receiptEyebrow', 'Payment received');
      text('successTitle', 'Thank you. Your payment is confirmed.');
      text('receiptMessage', 'The store has recorded your payment. Contact the store for delivery updates.');
    }
    text('receiptOrderRef', '#' + orderRef(order)); text('receiptAmount', money(order.payableAmount ?? order.amount)); text('receiptUtr', order.utr || order.paymentRef || 'Recorded by the store');
    const labels = { PENDING: 'Awaiting preparation', PACKING: 'Being prepared', PACKED: 'Packed', DISPATCHED: 'Shipped', SHIPPED: 'Shipped', DELIVERED: 'Delivered', CANCELLED: 'Cancelled' };
    text('receiptDeliveryStatus', labels[order.dispatchStatus] || 'Awaiting preparation'); text('receiptAddress', addressMasked(order) ? 'Delivery details are saved with the store and hidden on this device for privacy.' : addressText(order.address));
    populateSupport(order); setScreen('beatSuccessCard', focus);
  }

  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const value = $(button.dataset.copy)?.textContent; if (!value) return;
    try { await navigator.clipboard.writeText(value); announce('Copied to clipboard.'); } catch { announce('Couldn’t copy. You can select and copy the text above.'); }
  }));
  ['btnPayUpiIntent', 'btnPayUpiIntentDesktop'].forEach(id => $(id).addEventListener('click', event => {
    if (!$(id).hasAttribute('href')) { event.preventDefault(); announce('Contact the store to check the payment details.'); return; }
    hasLaunchedUpi = true; refreshPendingState(currentOrder);
    request(endpoint + '/event', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ event: 'REDIRECTED_TO_PAYMENT', app: 'UPI' }) }).catch(() => {});
  }));
  $('btnToggleQr').addEventListener('click', () => { const expanded = $('qrContainer').hidden; show('qrContainer', expanded); $('btnToggleQr').setAttribute('aria-expanded', String(expanded)); text('btnToggleQr', expanded ? 'Hide QR' : 'Show QR'); });
  $('btnEditAddress').addEventListener('click', () => { syncAddressStep('contact'); setScreen('beatAddressCard', true); });
  $('btnAddressNext').addEventListener('click', () => {
    for (const input of $('addressFields').querySelectorAll('.contact-step input')) {
      if (!input.reportValidity()) return;
    }
    syncAddressStep('location', true);
  });
  $('btnAddressBack').addEventListener('click', () => syncAddressStep('contact', true));
  $('btnOpenUtrEarly').addEventListener('click', openReferenceForm); $('utrDrawer').addEventListener('submit', submitReference);
  $('utrInput').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 12); }); $('addressForm').addEventListener('submit', saveAddress);
  $('addrPhone').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10); });
  $('addrPincode').addEventListener('input', event => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); clearTimeout(pincodeTimer); pincodeController?.abort(); const code = event.target.value;
    if (code.length === 6) pincodeTimer = setTimeout(() => lookupPincode(code), 300); else text('pincodeStatus', 'Enter all 6 digits, or fill in city and state yourself.');
  });
  $('btnCheckPayment').addEventListener('click', () => checkPayment(true)); $('btnRetryOrder').addEventListener('click', loadOrder);
  $('storeLogoImg').addEventListener('error', () => { show('storeLogoImg', false); show('storeLogoFallback'); }); $('billProductImg').addEventListener('error', () => show('billProductImg', false));
  deviceQuery.addEventListener('change', applyDeviceLayout);
  narrowQuery.addEventListener('change', () => syncAddressStep());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ['beatAddressCard', 'beatPaymentCard'].includes(screen)) checkPayment(false); else schedulePoll(); });
  window.addEventListener('offline', () => setPaymentStatus('You’re offline', 'Your details stay on this page. Reconnect before saving or checking a payment.'));
  window.addEventListener('online', () => { if (currentOrder && ['beatAddressCard', 'beatPaymentCard'].includes(screen)) checkPayment(true); }); window.addEventListener('pagehide', stopPolling);
  window.addEventListener('pageshow', event => { if (event.persisted && currentOrder && ['beatAddressCard', 'beatPaymentCard'].includes(screen)) startPolling(); });
  // All state and handlers exist before the first asynchronous load.
  syncAddressStep();
  loadOrder();
});
