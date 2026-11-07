// PaySap Customer Checkout - Progressive 3-Beat Flow with Tokenized URLs
// Features: Client-side QR, Device-Responsive UI, UTR Fallback Drawer, Store Branding
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  // Token-first: ?token=kav_8f9a2b7c4d (new), ?ref=104 (legacy backward compat)
  const orderToken = urlParams.get('token') || urlParams.get('ref') || '';

  const loadingCard = document.getElementById('loadingCard');
  const errorCard = document.getElementById('errorCard');
  const errorMsg = document.getElementById('errorMsg');
  const beatAddressCard = document.getElementById('beatAddressCard');
  const beatPaymentCard = document.getElementById('beatPaymentCard');
  const beatSuccessCard = document.getElementById('beatSuccessCard');

  // Brand & Order Summary Elements
  const ambientBrandName = document.getElementById('ambientBrandName');
  const checkoutBrandName = document.getElementById('checkoutBrandName');
  const checkoutBrandCat = document.getElementById('checkoutBrandCat');
  const billRefNumber = document.getElementById('billRefNumber');
  const billTotalAmount = document.getElementById('billTotalAmount');
  const reviewTotalAmount = document.getElementById('reviewTotalAmount');
  const billItemDesc = document.getElementById('billItemDesc');
  const reviewItemDesc = document.getElementById('reviewItemDesc');
  const reviewBrandName = document.getElementById('reviewBrandName');
  const billSkuBadge = document.getElementById('billSkuBadge');
  const billNotesRow = document.getElementById('billNotesRow');
  const billNotes = document.getElementById('billNotes');

  // Address Inputs
  const addressForm = document.getElementById('addressForm');
  const addrFullName = document.getElementById('addrFullName');
  const addrPhone = document.getElementById('addrPhone');
  const addrFlat = document.getElementById('addrFlat');
  const addrStreet = document.getElementById('addrStreet');
  const addrPincode = document.getElementById('addrPincode');
  const addrCity = document.getElementById('addrCity');
  const addrState = document.getElementById('addrState');
  const addrLandmark = document.getElementById('addrLandmark');
  const pincodeStatus = document.getElementById('pincodeStatus');

  // Payment Beat Elements
  const summaryDeliveryText = document.getElementById('summaryDeliveryText');
  const btnEditAddress = document.getElementById('btnEditAddress');
  const btnPayUpiIntent = document.getElementById('btnPayUpiIntent');
  const btnPayIntentText = document.getElementById('btnPayIntentText');
  const displayVpa = document.getElementById('displayVpa');
  const displayRefNote = document.getElementById('displayRefNote');
  const qrContainer = document.getElementById('qrContainer');
  const qrSvgWrapper = document.getElementById('qrSvgWrapper');

  // Store branding elements
  const storeBrandingBadge = document.getElementById('storeBrandingBadge');
  const storeLocationText = document.getElementById('storeLocationText');
  const storeInstaLink = document.getElementById('storeInstaLink');
  const storeBrandingBadgeBeat2 = document.getElementById('storeBrandingBadgeBeat2');
  const storeLocationTextBeat2 = document.getElementById('storeLocationTextBeat2');
  const storeInstaLinkBeat2 = document.getElementById('storeInstaLinkBeat2');
  const storeLogoImg = document.getElementById('storeLogoImg');
  const storeLogoFallback = document.getElementById('storeLogoFallback');

  // UTR Drawer elements
  const utrDrawer = document.getElementById('utrDrawer');
  const utrInput = document.getElementById('utrInput');
  const btnSubmitUtr = document.getElementById('btnSubmitUtr');
  const utrStatus = document.getElementById('utrStatus');

  // Receipt Elements
  const receiptOrderRef = document.getElementById('receiptOrderRef');
  const receiptAmount = document.getElementById('receiptAmount');
  const receiptUtr = document.getElementById('receiptUtr');
  const receiptAddress = document.getElementById('receiptAddress');
  const btnConfirmWhatsApp = document.getElementById('btnConfirmWhatsApp');

  let currentOrder = null;
  let pollInterval = null;
  let utrDrawerTimer = null;

  // Customer session management for PII protection:
  // Only the active browsing session that created or edited the address can see unmasked details.
  function getCustomerHeaders(extra = {}) {
    const sessionKey = sessionStorage.getItem('paysap_session_' + orderToken) || '';
    return {
      ...extra,
      'X-Order-Session': sessionKey
    };
  }

  // Detect device type for responsive UI
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (window.innerWidth <= 768 && 'ontouchstart' in window);

  // 1. Fetch Order Data
  if (!orderToken) {
    loadingCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMsg.textContent = 'No order token found. Please use the link shared by the merchant.';
    return;
  }

  try {
    const res = await fetch(`/api/orders/${orderToken}`, {
      headers: getCustomerHeaders()
    });
    if (!res.ok) {
      loadingCard.classList.add('hidden');
      errorCard.classList.remove('hidden');
      errorMsg.textContent = `Order was not found or may have expired. Please request a fresh link from the seller.`;
      return;
    }

    currentOrder = await res.json();

    // If order already paid, transition to Beat 3 (Success Receipt) immediately
    if (currentOrder.status === 'PAID') {
      loadingCard.classList.add('hidden');
      showSuccessReceipt(currentOrder);
      return;
    }

    // If item is out of stock, transition to Out of Stock screen immediately
    if (currentOrder.isOutOfStock || currentOrder.status === 'OUT_OF_STOCK') {
      loadingCard.classList.add('hidden');
      showOutOfStockCard(currentOrder);
      return;
    }

    populateOrderDetails(currentOrder);
    loadingCard.classList.add('hidden');

    // If customer already entered complete address previously, transition to Beat 2 (Payment)
    if (currentOrder.address && currentOrder.address.flat && currentOrder.address.pincode) {
      showBeatPayment();
    } else {
      showBeatAddress();
    }

    // Start background poller so payment is detected automatically
    startPollingForPayment();

  } catch (err) {
    console.error(err);
    loadingCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMsg.textContent = 'Could not load order details. Please check your network connection.';
  }

  function populateOrderDetails(order) {
    const payableAmount = order.payableAmount !== undefined ? order.payableAmount : (order.amount || 0);
    const formattedAmount = '₹' + Number(payableAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.title = `Pay ${formattedAmount} • ${order.brandName || 'Order Checkout'}`;

    if (ambientBrandName) ambientBrandName.textContent = order.brandName || 'Store Checkout';
    if (checkoutBrandName) checkoutBrandName.textContent = order.brandName || 'Store Name';
    if (checkoutBrandCat) checkoutBrandCat.textContent = order.brandCategory || 'Store Collection';
    if (reviewBrandName) reviewBrandName.textContent = order.brandName || 'Store';

    // Show token-based ref instead of sequential integer
    if (billRefNumber) billRefNumber.textContent = `#${order.token || order.ref}`;
    if (billTotalAmount) billTotalAmount.textContent = formattedAmount;
    if (reviewTotalAmount) reviewTotalAmount.textContent = formattedAmount;

    if (billItemDesc) billItemDesc.textContent = order.itemDescription;
    if (reviewItemDesc) reviewItemDesc.textContent = order.itemDescription;

    if (billSkuBadge) {
      if (order.sku) {
        billSkuBadge.textContent = `#${order.sku}`;
        billSkuBadge.classList.remove('hidden');
      } else {
        billSkuBadge.classList.add('hidden');
      }
    }

    const billProductImg = document.getElementById('billProductImg');
    if (billProductImg) {
      if (order.productImage) {
        billProductImg.src = order.productImage;
        billProductImg.classList.remove('hidden');
      } else {
        billProductImg.classList.add('hidden');
      }
    }

    if (order.notes && billNotes && billNotesRow) {
      billNotes.textContent = order.notes;
      billNotesRow.classList.remove('hidden');
    }

    // Pre-populate address inputs if customer details exist
    if (order.customerName && addrFullName) addrFullName.value = order.customerName;
    if (order.customerPhone && addrPhone) addrPhone.value = order.customerPhone;
    if (order.address) {
      if (addrFlat) addrFlat.value = order.address.flat || '';
      if (addrStreet) addrStreet.value = order.address.street || '';
      if (addrPincode) addrPincode.value = order.address.pincode || '';
      if (addrCity) addrCity.value = order.address.city || '';
      if (addrState) addrState.value = order.address.state || '';
      if (addrLandmark) addrLandmark.value = order.address.landmark || '';
    }

    updateDeliverySummaryText(order.address || {
      fullName: order.customerName,
      phone: order.customerPhone
    });

    // Setup UPI deep-link
    const vpa = order.upiId || 'store@upi';
    const refNote = `REF${order.ref}`;
    if (displayVpa) displayVpa.textContent = vpa;
    if (displayRefNote) displayRefNote.textContent = refNote;

    const upiUrl = order.upiIntentUrl || `upi://pay?pa=${vpa}&pn=${encodeURIComponent(order.brandName || 'Store')}&am=${(order.payableAmount || order.amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(refNote)}&tr=${order.ref}`;

    if (btnPayUpiIntent) {
      btnPayUpiIntent.href = upiUrl;
      btnPayUpiIntent.addEventListener('click', () => {
        handleUpiClick('UPI Intent Button');
      });
    }

    if (btnPayIntentText) {
      btnPayIntentText.textContent = `Pay ${formattedAmount} via UPI (GPay, PhonePe, etc.)`;
    }

    // Generate local QR Code (client-side, zero external API)
    generateQrSvg(upiUrl);

    // Apply device-responsive layout
    applyDeviceResponsiveLayout();

    // Populate store branding / social proof
    populateStoreBranding(order);
  }

  // Store branding & social proof
  function populateStoreBranding(order) {
    const hasBranding = order.storeLocation || order.storeInstagram || order.storeLogo;
    if (storeBrandingBadge && hasBranding) {
      storeBrandingBadge.classList.remove('hidden');
    }
    if (storeBrandingBadgeBeat2 && hasBranding) {
      storeBrandingBadgeBeat2.classList.remove('hidden');
    }

    if (order.storeLocation) {
      if (storeLocationText) {
        storeLocationText.textContent = order.storeLocation;
        storeLocationText.parentElement.classList.remove('hidden');
      }
      if (storeLocationTextBeat2) {
        storeLocationTextBeat2.textContent = order.storeLocation;
        storeLocationTextBeat2.parentElement.classList.remove('hidden');
      }
    }

    if (order.storeInstagram) {
      const handle = order.storeInstagram.replace(/^@/, '');
      if (storeInstaLink) {
        storeInstaLink.href = `https://instagram.com/${handle}`;
        storeInstaLink.textContent = `@${handle}`;
        storeInstaLink.parentElement.classList.remove('hidden');
      }
      if (storeInstaLinkBeat2) {
        storeInstaLinkBeat2.href = `https://instagram.com/${handle}`;
        storeInstaLinkBeat2.textContent = `@${handle}`;
        storeInstaLinkBeat2.parentElement.classList.remove('hidden');
      }
    }

    if (order.assuranceText) {
      document.querySelectorAll('.assurance-text').forEach(el => {
        el.textContent = `✨ ${order.assuranceText.replace(/^✨\s*/, '')}`;
      });
    }

    if (order.storeLogo) {
      if (storeLogoImg) {
        storeLogoImg.src = order.storeLogo;
        storeLogoImg.classList.remove('hidden');
      }
      if (storeLogoFallback) storeLogoFallback.classList.add('hidden');
    }
  }

  // Device-responsive layout: Mobile = UPI intent hero, Desktop = QR hero
  function applyDeviceResponsiveLayout() {
    const mobileHero = document.getElementById('mobilePayHero');
    const desktopHero = document.getElementById('desktopQrHero');
    const mobileQrToggle = document.getElementById('mobileQrToggle');
    const desktopPayLink = document.getElementById('desktopPayLink');

    if (isMobile) {
      // Mobile: UPI intent button is prominent, QR is collapsible
      if (mobileHero) mobileHero.classList.remove('hidden');
      if (desktopHero) desktopHero.classList.add('hidden');
      if (mobileQrToggle) mobileQrToggle.classList.remove('hidden');
      if (desktopPayLink) desktopPayLink.classList.add('hidden');
    } else {
      // Desktop: QR code is prominent, UPI intent is secondary link
      if (mobileHero) mobileHero.classList.add('hidden');
      if (desktopHero) desktopHero.classList.remove('hidden');
      if (mobileQrToggle) mobileQrToggle.classList.add('hidden');
      if (desktopPayLink) desktopPayLink.classList.remove('hidden');
    }
  }

  function updateDeliverySummaryText(addr) {
    if (!summaryDeliveryText) return;
    if (!addr || !addr.flat) {
      summaryDeliveryText.textContent = 'Address not specified yet.';
      return;
    }
    const parts = [
      addr.fullName,
      addr.phone ? `(+91 ${addr.phone})` : '',
      addr.flat,
      addr.street,
      addr.landmark,
      addr.city,
      addr.state ? `${addr.state} - ${addr.pincode}` : addr.pincode
    ].filter(Boolean);
    summaryDeliveryText.textContent = parts.join(', ');
  }

  // Transitions between Beats
  function showBeatAddress() {
    beatAddressCard.classList.remove('hidden');
    beatPaymentCard.classList.add('hidden');
    beatSuccessCard.classList.add('hidden');
  }

  function showBeatPayment() {
    beatAddressCard.classList.add('hidden');
    beatPaymentCard.classList.remove('hidden');
    beatSuccessCard.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Start 30-second UTR assistance drawer timer
    startUtrDrawerTimer();
  }

  // Edit Address button handler
  if (btnEditAddress) {
    btnEditAddress.addEventListener('click', () => {
      showBeatAddress();
    });
  }

  // Beat 1: Address Form Submit -> Save to Backend -> Transition to Beat 2
  if (addressForm) {
    addressForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btnContinueToPayment');
      const origText = submitBtn ? submitBtn.innerHTML : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span>Saving Address...</span>`;
      }

      const addressPayload = {
        fullName: addrFullName.value.trim(),
        phone: addrPhone.value.trim(),
        flat: addrFlat.value.trim(),
        street: addrStreet.value.trim(),
        landmark: (addrLandmark.value || '').trim(),
        pincode: addrPincode.value.trim(),
        city: addrCity.value.trim() || 'City',
        state: addrState.value.trim() || 'State'
      };

      try {
        const saveRes = await fetch(`/api/orders/${orderToken}/address`, {
          method: 'POST',
          headers: getCustomerHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(addressPayload)
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          alert(saveData.error || 'Please fill in all mandatory address fields.');
          return;
        }
        if (saveData.customerSessionKey) {
          sessionStorage.setItem('paysap_session_' + orderToken, saveData.customerSessionKey);
        }
        if (saveData.order) {
          currentOrder = saveData.order;
        }

        updateDeliverySummaryText(addressPayload);
        showBeatPayment();
      } catch (err) {
        console.warn('Address save network error:', err);
        alert('Connection error while saving address. Please try again.');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = origText;
        }
      }
    });
  }

  // Pincode auto-detect with debounce
  let pincodeTimeout = null;
  if (addrPincode) {
    addrPincode.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '').slice(0, 6);
      e.target.value = val;

      clearTimeout(pincodeTimeout);
      if (val.length === 6) {
        pincodeStatus.textContent = 'Checking...';
        pincodeTimeout = setTimeout(() => {
          lookupPincode(val);
        }, 250);
      } else {
        pincodeStatus.textContent = '';
      }
    });
  }

  async function lookupPincode(code) {
    pincodeStatus.textContent = 'Looking up...';
    pincodeStatus.className = 'text-[10px] text-indigo-600 font-semibold';
    try {
      const res = await fetch(`/api/pincode/${code}`);
      if (!res.ok) throw new Error('Not found');
      const json = await res.json();
      if (json.success && json.data) {
        if (json.data.city && addrCity) addrCity.value = json.data.city;
        if (json.data.state && addrState) addrState.value = json.data.state;
        const locationText = json.data.city && json.data.state 
          ? `${json.data.city}, ${json.data.state}`
          : (json.data.city || json.data.state || '');
        pincodeStatus.textContent = `✓ ${locationText}`;
        pincodeStatus.className = 'text-[10px] text-emerald-600 font-bold truncate max-w-[180px]';
      } else {
        pincodeStatus.textContent = 'Please confirm city below';
        pincodeStatus.className = 'text-[10px] text-amber-600 font-medium';
      }
    } catch (err) {
      pincodeStatus.textContent = 'Please confirm city below';
      pincodeStatus.className = 'text-[10px] text-amber-600 font-medium';
    }
  }

  // QR Code Toggle (Mobile secondary)
  const btnToggleQr = document.getElementById('btnToggleQr');
  if (btnToggleQr && qrContainer) {
    btnToggleQr.addEventListener('click', () => {
      if (qrContainer.classList.contains('hidden')) {
        qrContainer.classList.remove('hidden');
        btnToggleQr.textContent = 'Hide QR Code';
        btnToggleQr.className = 'px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-2xs';
        setTimeout(() => {
          qrContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 60);
      } else {
        qrContainer.classList.add('hidden');
        btnToggleQr.textContent = 'Show QR Code';
        btnToggleQr.className = 'px-3.5 py-1.5 bg-white hover:bg-slate-100 text-indigo-700 border border-slate-200 text-xs font-bold rounded-xl transition-all cursor-pointer shadow-2xs';
      }
    });
  }

  // ==========================================
  // CLIENT-SIDE QR CODE GENERATOR (100% Offline, Zero External API, Zero Data Leak)
  // Generates clean SVG elements using bundled qrcode.min.js
  // ==========================================
  function generateQrSvg(text) {
    if (!text) return;
    try {
      if (window.QRCode && typeof window.QRCode.generateSvg === 'function') {
        const svg = window.QRCode.generateSvg(text, {
          colorDark: '#1e1b4b',
          colorLight: '#ffffff',
          margin: 2
        });
        if (qrSvgWrapper) qrSvgWrapper.innerHTML = svg;
        const qrSvgWrapperMobile = document.getElementById('qrSvgWrapperMobile');
        if (qrSvgWrapperMobile) qrSvgWrapperMobile.innerHTML = svg;
        return;
      }
    } catch (e) {
      console.warn('Client-side QR generation error:', e);
      if (qrSvgWrapper) {
        qrSvgWrapper.innerHTML = '<div class="text-xs text-slate-500 font-medium text-center p-4">Please scan UPI ID manually</div>';
      }
    }
  }

  // Minimal QR Code matrix generator (Version 2-6, Byte mode, ECC-L)
  function generateQrMatrix(data) {
    // Use a compact byte-mode QR encoder
    const byteData = new TextEncoder().encode(data);
    const dataLen = byteData.length;
    
    // Determine version (1-6 for typical UPI URLs ~200 bytes)
    let version, totalCodewords, ecCodewords, groups;
    if (dataLen <= 17) { version = 1; totalCodewords = 19; ecCodewords = 7; groups = [[1, 19]]; }
    else if (dataLen <= 32) { version = 2; totalCodewords = 34; ecCodewords = 10; groups = [[1, 34]]; }
    else if (dataLen <= 53) { version = 3; totalCodewords = 55; ecCodewords = 15; groups = [[1, 55]]; }
    else if (dataLen <= 78) { version = 4; totalCodewords = 80; ecCodewords = 20; groups = [[1, 80]]; }
    else if (dataLen <= 106) { version = 5; totalCodewords = 108; ecCodewords = 26; groups = [[1, 108]]; }
    else if (dataLen <= 134) { version = 6; totalCodewords = 136; ecCodewords = 18; groups = [[2, 68]]; }
    else if (dataLen <= 154) { version = 7; totalCodewords = 156; ecCodewords = 20; groups = [[2, 78]]; }
    else if (dataLen <= 192) { version = 8; totalCodewords = 194; ecCodewords = 24; groups = [[2, 97]]; }
    else if (dataLen <= 230) { version = 9; totalCodewords = 232; ecCodewords = 30; groups = [[2, 116]]; }
    else if (dataLen <= 271) { version = 10; totalCodewords = 274; ecCodewords = 18; groups = [[2, 68], [2, 69]]; }
    else if (dataLen <= 321) { version = 11; totalCodewords = 324; ecCodewords = 20; groups = [[4, 81]]; }
    else if (dataLen <= 367) { version = 12; totalCodewords = 370; ecCodewords = 24; groups = [[2, 92], [2, 93]]; }
    else if (dataLen <= 425) { version = 13; totalCodewords = 428; ecCodewords = 26; groups = [[4, 107]]; }
    else { version = 14; totalCodewords = 461; ecCodewords = 30; groups = [[3, 115], [1, 116]]; }
    
    const size = version * 4 + 17;
    const matrix = Array.from({length: size}, () => Array(size).fill(null));
    const reserved = Array.from({length: size}, () => Array(size).fill(false));
    
    // Place finder patterns
    placeFinder(matrix, reserved, 0, 0);
    placeFinder(matrix, reserved, 0, size - 7);
    placeFinder(matrix, reserved, size - 7, 0);
    
    // Place timing patterns
    for (let i = 8; i < size - 8; i++) {
      matrix[6][i] = i % 2 === 0;
      reserved[6][i] = true;
      matrix[i][6] = i % 2 === 0;
      reserved[i][6] = true;
    }
    
    // Place alignment patterns for version >= 2
    if (version >= 2) {
      const alignPositions = getAlignmentPositions(version, size);
      for (const r of alignPositions) {
        for (const c of alignPositions) {
          if (reserved[r][c]) continue;
          placeAlignment(matrix, reserved, r, c);
        }
      }
    }
    
    // Reserve format info areas
    reserveFormatInfo(matrix, reserved, size);
    
    // Reserve version info for version >= 7
    if (version >= 7) {
      reserveVersionInfo(reserved, size);
    }
    
    // Dark module
    matrix[size - 8][8] = true;
    reserved[size - 8][8] = true;
    
    // Encode data
    const dataCodewords = encodeByteData(byteData, totalCodewords - ecCodewords);
    const ecWords = generateEC(dataCodewords, ecCodewords);
    const allCodewords = [...dataCodewords, ...ecWords];
    
    // Place data bits
    placeDataBits(matrix, reserved, allCodewords, size);
    
    // Apply best mask
    const bestMask = applyBestMask(matrix, reserved, size);
    
    // Write format info
    writeFormatInfo(matrix, size, bestMask);
    
    // Write version info for version >= 7
    if (version >= 7) {
      writeVersionInfo(matrix, size, version);
    }
    
    return matrix;
  }
  
  function placeFinder(matrix, reserved, row, col) {
    const pattern = [
      [1,1,1,1,1,1,1],
      [1,0,0,0,0,0,1],
      [1,0,1,1,1,0,1],
      [1,0,1,1,1,0,1],
      [1,0,1,1,1,0,1],
      [1,0,0,0,0,0,1],
      [1,1,1,1,1,1,1]
    ];
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r, mc = col + c;
        if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;
        if (r >= 0 && r < 7 && c >= 0 && c < 7) {
          matrix[mr][mc] = !!pattern[r][c];
        } else {
          matrix[mr][mc] = false;
        }
        reserved[mr][mc] = true;
      }
    }
  }
  
  function placeAlignment(matrix, reserved, centerRow, centerCol) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const mr = centerRow + r, mc = centerCol + c;
        matrix[mr][mc] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
        reserved[mr][mc] = true;
      }
    }
  }
  
  function getAlignmentPositions(version, size) {
    if (version === 1) return [];
    const positions = [6];
    const last = size - 7;
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((last - 6) / (count - 1));
    const adjustedStep = step % 2 === 0 ? step : step + 1;
    let pos = last;
    const result = [last];
    for (let i = 1; i < count - 1; i++) {
      pos -= adjustedStep;
      result.unshift(pos);
    }
    result.unshift(6);
    return result;
  }
  
  function reserveFormatInfo(matrix, reserved, size) {
    for (let i = 0; i < 8; i++) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
    reserved[8][8] = true;
    for (let i = 0; i < 7; i++) {
      reserved[8][size - 1 - i] = true;
      reserved[size - 1 - i][8] = true;
    }
    reserved[8][size - 8] = true;
  }
  
  function reserveVersionInfo(reserved, size) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }
  
  function encodeByteData(bytes, capacity) {
    const bits = [];
    // Mode indicator: Byte mode = 0100
    bits.push(0, 1, 0, 0);
    // Character count (8 bits for version 1-9, 16 for 10+)
    const lenBits = capacity > 127 ? 16 : 8;
    for (let i = lenBits - 1; i >= 0; i--) {
      bits.push((bytes.length >> i) & 1);
    }
    // Data
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) {
        bits.push((b >> i) & 1);
      }
    }
    // Terminator
    const totalBits = capacity * 8;
    while (bits.length < totalBits && bits.length < totalBits) {
      bits.push(0);
      if (bits.length >= totalBits) break;
    }
    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);
    // Pad codewords
    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (bits.length < totalBits) {
      for (let i = 7; i >= 0; i--) {
        bits.push((padBytes[padIdx] >> i) & 1);
      }
      padIdx = (padIdx + 1) % 2;
    }
    
    // Convert to bytes
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8 && (i + j) < bits.length; j++) {
        byte = (byte << 1) | bits[i + j];
      }
      codewords.push(byte);
    }
    return codewords.slice(0, capacity);
  }
  
  function generateEC(data, ecLen) {
    // Reed-Solomon error correction using GF(256)
    const gfExp = new Array(512);
    const gfLog = new Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      gfExp[i] = x;
      gfLog[x] = i;
      x = x * 2;
      if (x >= 256) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
    
    function gfMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return gfExp[gfLog[a] + gfLog[b]];
    }
    
    // Generate generator polynomial
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const newGen = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        newGen[j] ^= gen[j];
        newGen[j + 1] ^= gfMul(gen[j], gfExp[i]);
      }
      gen = newGen;
    }
    
    // Polynomial division
    const msg = [...data, ...new Array(ecLen).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 1; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }
  
  function placeDataBits(matrix, reserved, codewords, size) {
    const bits = [];
    for (const cw of codewords) {
      for (let i = 7; i >= 0; i--) {
        bits.push((cw >> i) & 1);
      }
    }
    
    let bitIdx = 0;
    let upward = true;
    
    for (let col = size - 1; col >= 0; col -= 2) {
      if (col === 6) col = 5; // Skip timing column
      
      const rows = upward ? 
        Array.from({length: size}, (_, i) => size - 1 - i) :
        Array.from({length: size}, (_, i) => i);
      
      for (const row of rows) {
        for (const dc of [0, -1]) {
          const c = col + dc;
          if (c < 0 || c >= size) continue;
          if (reserved[row][c]) continue;
          if (bitIdx < bits.length) {
            matrix[row][c] = !!bits[bitIdx];
            bitIdx++;
          } else {
            matrix[row][c] = false;
          }
        }
      }
      upward = !upward;
    }
  }
  
  function applyBestMask(matrix, reserved, size) {
    let bestMask = 0;
    let bestPenalty = Infinity;
    
    for (let mask = 0; mask < 8; mask++) {
      const test = matrix.map(row => [...row]);
      applyMask(test, reserved, size, mask);
      const penalty = calculatePenalty(test, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
    }
    
    applyMask(matrix, reserved, size, bestMask);
    return bestMask;
  }
  
  function applyMask(matrix, reserved, size, mask) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = (r * c) % 2 + (r * c) % 3 === 0; break;
          case 6: invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0; break;
          case 7: invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0; break;
        }
        if (invert) matrix[r][c] = !matrix[r][c];
      }
    }
  }
  
  function calculatePenalty(matrix, size) {
    let penalty = 0;
    // Rule 1: consecutive same-color modules in rows/cols
    for (let r = 0; r < size; r++) {
      let count = 1;
      for (let c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c-1]) { count++; }
        else { if (count >= 5) penalty += count - 2; count = 1; }
      }
      if (count >= 5) penalty += count - 2;
    }
    for (let c = 0; c < size; c++) {
      let count = 1;
      for (let r = 1; r < size; r++) {
        if (matrix[r][c] === matrix[r-1][c]) { count++; }
        else { if (count >= 5) penalty += count - 2; count = 1; }
      }
      if (count >= 5) penalty += count - 2;
    }
    // Rule 4: proportion of dark modules
    let dark = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (matrix[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    penalty += Math.abs(Math.floor(pct / 5) * 5 - 50) * 2;
    return penalty;
  }
  
  function writeFormatInfo(matrix, size, mask) {
    // ECC Level L = 01, mask pattern
    const formatBits = (1 << 3) | mask; // 01 + mask
    let data = formatBits;
    // BCH(15,5) encoding
    const gen = 0x537;
    let d = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (d & (1 << (i + 10))) d ^= gen << i;
    }
    const encoded = ((formatBits << 10) | d) ^ 0x5412;
    
    // Place format bits
    const bits = [];
    for (let i = 14; i >= 0; i--) {
      bits.push((encoded >> i) & 1);
    }
    
    // Around top-left finder
    const positions1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
      [8, 7], [8, 8], [7, 8],
      [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    // Around bottom-left and top-right
    const positions2 = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
    ];
    
    for (let i = 0; i < 15; i++) {
      matrix[positions1[i][0]][positions1[i][1]] = !!bits[i];
      matrix[positions2[i][0]][positions2[i][1]] = !!bits[i];
    }
  }
  
  function writeVersionInfo(matrix, size, version) {
    if (version < 7) return;
    // BCH(18,6) encoding for version info
    const versionInfoTable = [
      0, 0, 0, 0, 0, 0, 0, // 0-6: not used
      0x07C94, 0x085BC, 0x09A99, 0x0A4D3, 0x0BBF6, 0x0C762, 0x0D847,
      0x0E60D, 0x0F928, 0x10B78, 0x1145D, 0x12A17, 0x13532, 0x149A6,
      0x15683, 0x168C9, 0x177EC, 0x18EC4, 0x191E1, 0x1AFAB, 0x1B08E,
      0x1CC1A, 0x1D33F, 0x1ED75, 0x1F250, 0x209D5, 0x216F0, 0x228BA,
      0x2379F, 0x24B0B, 0x2542E, 0x26A64, 0x27541, 0x28C69
    ];
    const info = version < versionInfoTable.length ? versionInfoTable[version] : 0;
    if (!info) return;
    
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      matrix[r][c] = !!bit;
      matrix[c][r] = !!bit;
    }
  }

  // 1-Tap UPI app launch handler
  window.launchUpiWithApp = function(appName) {
    handleUpiClick(appName);
    if (!currentOrder) return;
    const vpa = currentOrder.upiId || 'store@upi';
    const refNote = `REF${currentOrder.ref}`;
    const payable = (currentOrder.payableAmount !== undefined ? currentOrder.payableAmount : currentOrder.amount).toFixed(2);
    const upiUrl = `upi://pay?pa=${vpa}&pn=${encodeURIComponent(currentOrder.brandName || 'Store')}&am=${payable}&cu=INR&tn=${encodeURIComponent(refNote)}&tr=${currentOrder.ref}`;
    window.location.href = upiUrl;
  };

  // Helper to copy text from detail elements
  window.copyDetailText = function(elementId, btn) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.innerText || el.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied ${text}!`);
      if (btn) {
        const orig = btn.innerText;
        btn.innerText = 'Copied!';
        setTimeout(() => { btn.innerText = orig; }, 1500);
      }
    });
  };

  function handleUpiClick(appName) {
    if (!currentOrder) return;
    const token = currentOrder.token || currentOrder.ref;
    fetch(`/api/orders/${token}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'REDIRECTED_TO_PAYMENT', app: appName })
    }).catch(() => {});
    showToast(`Launching ${appName}...`);
    openUtrDrawer('UPI app launched! Once paid, enter your 12-digit UTR below to confirm:');
  }

  // ==========================================
  // UTR FALLBACK ASSISTANCE DRAWER
  // Instant access on return from UPI app or manual click
  // ==========================================
  function openUtrDrawer(reason = '') {
    if (utrDrawerTimer) {
      clearTimeout(utrDrawerTimer);
      utrDrawerTimer = null;
    }
    if (!utrDrawer) return;

    utrDrawer.classList.remove('hidden');
    utrDrawer.style.animation = 'slideUp 0.3s ease-out forwards';
    const indicator = document.getElementById('bankConfirmIndicator');
    if (indicator && reason) {
      indicator.textContent = reason;
    }
    if (utrInput) {
      setTimeout(() => utrInput.focus(), 150);
    }
  }

  function startUtrDrawerTimer() {
    if (utrDrawerTimer) clearTimeout(utrDrawerTimer);
    if (!utrDrawer) return;

    utrDrawerTimer = setTimeout(() => {
      openUtrDrawer('Still waiting? Enter 12-digit UPI reference (UTR) below:');
    }, 15000); // 15 seconds progressive reveal
  }

  // Instant UTR triggers: btnIHavePaid and btnOpenUtrEarly
  const btnIHavePaid = document.getElementById('btnIHavePaid');
  if (btnIHavePaid) {
    btnIHavePaid.addEventListener('click', () => {
      openUtrDrawer('Enter your 12-digit UPI reference number (UTR) to confirm:');
      if (utrDrawer) {
        utrDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  const btnOpenUtrEarly = document.getElementById('btnOpenUtrEarly');
  if (btnOpenUtrEarly) {
    btnOpenUtrEarly.addEventListener('click', () => {
      openUtrDrawer('Enter your 12-digit UPI reference number (UTR) to confirm:');
      if (utrDrawer) {
        utrDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  // UTR submission handler
  if (btnSubmitUtr && utrInput) {
    // Auto-format: only digits, max 12
    utrInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 12);
      btnSubmitUtr.disabled = e.target.value.length !== 12;
    });

    utrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btnSubmitUtr.disabled) {
        e.preventDefault();
        btnSubmitUtr.click();
      }
    });

    btnSubmitUtr.addEventListener('click', async () => {
      const utrValue = utrInput.value.trim();
      if (utrValue.length !== 12) return;

      btnSubmitUtr.disabled = true;
      btnSubmitUtr.textContent = 'Verifying...';
      if (utrStatus) {
        utrStatus.textContent = 'Contacting payment confirmation engine...';
        utrStatus.className = 'text-xs font-semibold text-indigo-600 mt-1';
      }

      try {
        const token = currentOrder.token || currentOrder.ref;
        const res = await fetch(`/api/orders/${token}/utr`, {
          method: 'POST',
          headers: getCustomerHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ utr: utrValue })
        });
        const data = await res.json();

        if (data.success) {
          if (utrStatus) {
            utrStatus.textContent = '✓ Payment verified successfully!';
            utrStatus.className = 'text-xs font-bold text-emerald-600 mt-1';
          }
          playCelebrationSound();
          triggerConfetti();
          setTimeout(() => showSuccessReceipt(data.order), 500);
        } else {
          if (utrStatus) {
            utrStatus.textContent = data.error || 'Verification failed. Please check UTR and try again.';
            utrStatus.className = 'text-xs font-medium text-rose-600 mt-1';
          }
          btnSubmitUtr.disabled = false;
          btnSubmitUtr.textContent = 'Verify Instant';
        }
      } catch (err) {
        if (utrStatus) {
          utrStatus.textContent = 'Network error. Please try again.';
          utrStatus.className = 'text-xs font-medium text-rose-600 mt-1';
        }
        btnSubmitUtr.disabled = false;
        btnSubmitUtr.textContent = 'Verify Instant';
      }
    });
  }

  // Background Poller: Checks backend every 1.0 second for auto-detected payment
  async function pollPaymentStatusOnce() {
    if (!orderToken) return;
    try {
      const res = await fetch(`/api/orders/${orderToken}`, {
        headers: getCustomerHeaders()
      });
      if (!res.ok) return;
      const order = await res.json();

      if (order.status === 'PAID') {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        if (utrDrawerTimer) {
          clearTimeout(utrDrawerTimer);
          utrDrawerTimer = null;
        }
        playCelebrationSound();
        triggerConfetti();
        showSuccessReceipt(order);
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }

  let pollCount = 0;
  const MAX_POLL_COUNT = 600; // Stop polling after 10 minutes (600 * 1s)

  function startPollingForPayment() {
    if (pollInterval) clearInterval(pollInterval);
    pollCount = 0;
    pollInterval = setInterval(() => {
      pollCount++;
      if (pollCount > MAX_POLL_COUNT) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log('Auto-poll stopped after 10 minutes. Page refresh to resume.');
        return;
      }
      pollPaymentStatusOnce();
    }, 1000);
  }

  // Instant verification & immediate UTR assist when returning from UPI app
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (pollInterval) {
        pollPaymentStatusOnce();
      }
      if (currentOrder && currentOrder.status !== 'PAID') {
        openUtrDrawer('Returned from UPI app? Enter your 12-digit UTR to confirm:');
      }
    }
  });

  // Beat 3: Celebratory Receipt
  function showSuccessReceipt(order) {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (utrDrawerTimer) {
      clearTimeout(utrDrawerTimer);
      utrDrawerTimer = null;
    }

    beatAddressCard.classList.add('hidden');
    beatPaymentCard.classList.add('hidden');
    beatSuccessCard.classList.remove('hidden');

    const amountFormatted = '₹' + (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);
    if (receiptOrderRef) receiptOrderRef.textContent = `#${order.token || order.ref}`;
    if (receiptAmount) receiptAmount.textContent = amountFormatted;
    if (receiptUtr) receiptUtr.textContent = order.utr || order.paymentRef || 'Verified';

    const addr = order.address || {};
    const formattedAddr = [
      addr.fullName,
      addr.phone ? `(+91 ${addr.phone})` : '',
      addr.flat,
      addr.street,
      addr.landmark,
      addr.city,
      addr.state ? `${addr.state} - ${addr.pincode}` : addr.pincode
    ].filter(Boolean).join(', ');

    if (receiptAddress) {
      receiptAddress.textContent = formattedAddr || 'Doorstep delivery address on record';
    }

    const brand = order.brandName || 'Store';
    const waText = `Hi ${brand}! ✨\n\nI have completed payment of ${amountFormatted} for Order #${order.token || order.ref} (${order.itemDescription}).\n\nDelivery Address:\n${formattedAddr}\n\nPlease share my tracking number once dispatched. Thank you!`;

    const merchantPhone = (order.storePhone || order.sellerPhone || '').replace(/\D/g, '').slice(-10);
    const waUrl = merchantPhone ? `https://wa.me/91${merchantPhone}?text=${encodeURIComponent(waText)}` : `https://wa.me/?text=${encodeURIComponent(waText)}`;

    if (btnConfirmWhatsApp) {
      btnConfirmWhatsApp.href = waUrl;
    }
  }

  // Celebration Sound
  function playCelebrationSound() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) {}
  }

  // Confetti Animation
  function triggerConfetti() {
    try {
      const count = 35;
      const colors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6'];
      for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.style.position = 'fixed';
        p.style.width = '8px';
        p.style.height = '8px';
        p.style.borderRadius = '2px';
        p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        p.style.left = (window.innerWidth / 2 + (Math.random() - 0.5) * 200) + 'px';
        p.style.top = (window.innerHeight / 3 + (Math.random() - 0.5) * 100) + 'px';
        p.style.zIndex = '9999';
        p.style.pointerEvents = 'none';
        p.style.transition = 'all 1.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
        document.body.appendChild(p);

        setTimeout(() => {
          p.style.transform = `translate(${(Math.random() - 0.5) * 400}px, ${Math.random() * 350 + 100}px) rotate(${Math.random() * 360}deg)`;
          p.style.opacity = '0';
        }, 20);

        setTimeout(() => {
          if (p.parentElement) p.parentElement.removeChild(p);
        }, 1300);
      }
    } catch (e) {}
  }

  function showOutOfStockCard(order) {
    const oosCard = document.getElementById('beatOutOfStockCard');
    const oosItemName = document.getElementById('oosItemName');
    const oosOrderRef = document.getElementById('oosOrderRef');
    const oosBrandName = document.getElementById('oosBrandName');
    const oosAmount = document.getElementById('oosAmount');
    const btnOosWhatsApp = document.getElementById('btnOosWhatsApp');

    const formattedAmount = '₹' + (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);

    if (ambientBrandName) ambientBrandName.textContent = order.brandName || 'Store Checkout';
    if (oosItemName) oosItemName.textContent = order.itemDescription;
    if (oosOrderRef) oosOrderRef.textContent = `#${order.token || order.ref}`;
    if (oosBrandName) oosBrandName.textContent = order.brandName || 'Store';
    if (oosAmount) oosAmount.textContent = formattedAmount;

    if (btnOosWhatsApp) {
      const msg = encodeURIComponent(`Hi ${order.brandName || 'there'}! ✨\n\nI opened checkout link #${order.token || order.ref} for "${order.itemDescription}" (${formattedAmount}), but it shows out of stock. Can you please check if another piece can be reserved or restocked for me? Thank you!`);
      const phone = (order.sellerPhone || '').replace(/\D/g, '');
      if (phone) {
        const targetPhone = phone.startsWith('91') ? phone : '91' + phone;
        btnOosWhatsApp.href = `https://wa.me/${targetPhone}?text=${msg}`;
      } else {
        btnOosWhatsApp.href = `https://wa.me/?text=${msg}`;
      }
    }

    if (oosCard) oosCard.classList.remove('hidden');
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
});
