// Authentication, store lookup, staff PIN login, store registration, and owner password recovery.

let publicStores = [];
let currentAuthMode = 'OWNER';

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
  }, 3000);
}

function switchAuthMode(mode) {
  currentAuthMode = mode;
  const tabBtnSalesman = document.getElementById('tabBtnSalesman');
  const tabBtnOwner = document.getElementById('tabBtnOwner');
  const tabBtnRegister = document.getElementById('tabBtnRegister');
  const salesmanForm = document.getElementById('salesmanForm');
  const ownerForm = document.getElementById('ownerForm');
  const registerForm = document.getElementById('registerForm');
  const recoveryPanel = document.getElementById('recoveryPanel');

  const inactiveTabClass = 'flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer text-slate-500 hover:text-slate-800 text-center flex items-center justify-center gap-1';
  const activeTabClass = 'flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer bg-white text-slate-900 shadow-xs text-center flex items-center justify-center gap-1';

  [tabBtnSalesman, tabBtnOwner, tabBtnRegister].forEach(b => {
    if (b) b.className = inactiveTabClass;
  });

  if (salesmanForm) salesmanForm.classList.add('hidden');
  if (ownerForm) ownerForm.classList.add('hidden');
  if (registerForm) registerForm.classList.add('hidden');
  if (recoveryPanel) recoveryPanel.classList.add('hidden');

  if (mode === 'SALESMAN') {
    if (tabBtnSalesman) tabBtnSalesman.className = activeTabClass;
    if (salesmanForm) salesmanForm.classList.remove('hidden');
    document.getElementById('salesmanPin')?.focus();
  } else if (mode === 'OWNER') {
    if (tabBtnOwner) tabBtnOwner.className = activeTabClass;
    if (ownerForm) ownerForm.classList.remove('hidden');
    document.getElementById('ownerEmail')?.focus();
  } else if (mode === 'REGISTER') {
    if (tabBtnRegister) tabBtnRegister.className = activeTabClass;
    if (registerForm) registerForm.classList.remove('hidden');
    document.getElementById('regBrandName')?.focus();
  } else if (mode === 'RECOVERY') {
    if (tabBtnOwner) tabBtnOwner.className = activeTabClass;
    if (recoveryPanel) recoveryPanel.classList.remove('hidden');
    const resetTokenInput = document.getElementById('resetTokenInput');
    if (resetTokenInput && resetTokenInput.value.trim()) {
      document.getElementById('resetNewPassword')?.focus();
    } else {
      document.getElementById('recoveryEmail')?.focus();
    }
  }
}

async function loadPublicStores() {
  const input = document.getElementById('staffStoreLookup');
  const status = document.getElementById('storeLookupStatus');
  if (!input || !status) return;
  const lookup = input.value.trim();
  if (!lookup) {
    status.textContent = 'Enter your Store ID or owner email first.';
    return;
  }
  status.textContent = 'Finding your store…';
  try {
    const res = await fetch('/api/public/stores?storeId=' + encodeURIComponent(lookup));
    const data = await res.json();
    publicStores = data.stores || [];
    const select = document.getElementById('salesmanStoreSelect');
    if (!select) return;
    select.innerHTML = '<option value="">Choose your store</option>';
    publicStores.forEach(store => {
      const option = document.createElement('option');
      option.value = store.id;
      option.textContent = store.brandName;
      select.appendChild(option);
    });
    if (publicStores.length) {
      select.value = publicStores[0].id;
      onStoreSelectChange(select.value);
      status.textContent = 'Store found. Choose your name and enter your PIN.';
    } else {
      onStoreSelectChange('');
      status.textContent = 'No matching store. Check the ID or email with your owner.';
    }
  } catch (_) {
    status.textContent = 'Couldn’t connect. Try again when you’re online.';
  }
}

function onStoreSelectChange(storeId) {
  const staffSelect = document.getElementById('salesmanStaffSelect');
  if (!staffSelect) return;
  staffSelect.innerHTML = '';

  if (!storeId) {
    staffSelect.innerHTML = '<option value="">-- Select store first --</option>';
    return;
  }

  localStorage.setItem('last_store_id', storeId);
  const store = publicStores.find(s => s.id === storeId);
  if (!store || !store.salesmen || store.salesmen.length === 0) {
    staffSelect.innerHTML = '<option value="">-- No salesmen found (Use Owner Login) --</option>';
    return;
  }

  store.salesmen.forEach(sm => {
    const opt = document.createElement('option');
    opt.value = sm.id;
    opt.textContent = sm.name;
    staffSelect.appendChild(opt);
  });
}

async function handleSalesmanLogin() {
  const storeId = document.getElementById('salesmanStoreSelect')?.value;
  const salesmanId = document.getElementById('salesmanStaffSelect')?.value;
  const pin = document.getElementById('salesmanPin')?.value.trim();

  if (!storeId) {
    showToast('⚠️ Please select your store.');
    return;
  }
  if (!pin || pin.length < 4) {
    showToast('⚠️ Please enter your 4-digit PIN.');
    return;
  }

  const btn = document.getElementById('btnSalesmanSubmit');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">refresh</span><span>Verifying PIN...</span>';

  try {
    const res = await fetch('/api/auth/salesman-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ storeId, salesmanId, pin })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.error || 'Invalid PIN. Please try again.'));
      return;
    }

    localStorage.removeItem('auth_token');
    localStorage.setItem('auth_role', 'SALESMAN');
    localStorage.removeItem('seller_profile');
    localStorage.setItem('salesman_profile', JSON.stringify(data.salesman));

    showToast(`✨ Welcome, ${data.salesman.name}! Launching sales cockpit...`);
    setTimeout(() => {
      window.location.href = '/';
    }, 500);
  } catch (err) {
    console.error(err);
    showToast('⚠️ Connection error. Please ensure server is running.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function handleOwnerLogin() {
  const email = document.getElementById('ownerEmail')?.value.trim();
  const password = document.getElementById('ownerPassword')?.value;

  if (!email || !password) {
    showToast('⚠️ Please enter store email and password.');
    return;
  }

  const btn = document.getElementById('btnOwnerSubmit');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">refresh</span><span>Authenticating Store...</span>';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.error || 'Invalid email or store password.'));
      return;
    }

    localStorage.removeItem('auth_token');
    localStorage.setItem('auth_role', 'OWNER');
    localStorage.removeItem('seller_profile');
    localStorage.removeItem('salesman_profile');

    showToast(`👑 Welcome Owner! Opening ${data.seller.brandName} Store dashboard...`);
    setTimeout(() => {
      window.location.href = '/';
    }, 500);
  } catch (err) {
    console.error(err);
    showToast('⚠️ Connection error. Please check server.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function handleForgotPassword() {
  const emailInput = document.getElementById('recoveryEmail');
  const statusEl = document.getElementById('recoveryStatus');
  const btn = document.getElementById('btnSendRecovery');
  const email = emailInput ? emailInput.value.trim() : '';
  if (!email) {
    showToast('⚠️ Enter your registered store owner email.');
    return;
  }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>Sending...</span>';
  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast('⚠️ ' + (data.error || 'Unable to process recovery request.'));
      if (statusEl) statusEl.textContent = data.error || 'Unable to process recovery request.';
      return;
    }
    const msg = data.message || 'If an owner account matches that email, reset instructions were issued.';
    if (statusEl) statusEl.textContent = msg;
    showToast('✅ ' + msg);
  } catch (_) {
    showToast('⚠️ Connection error.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function handleResetPassword() {
  const token = document.getElementById('resetTokenInput')?.value.trim();
  const newPassword = document.getElementById('resetNewPassword')?.value || '';
  const statusEl = document.getElementById('recoveryStatus');
  const btn = document.getElementById('btnCompleteReset');

  if (!token) {
    showToast('⚠️ Enter your password reset token.');
    return;
  }
  if (newPassword.length < 10) {
    showToast('⚠️ New password must be at least 10 characters.');
    return;
  }

  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>Updating...</span>';

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token, newPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.error || 'Password reset failed.'));
      if (statusEl) statusEl.textContent = data.error || 'Password reset failed.';
      return;
    }
    showToast('✅ ' + (data.message || 'Password updated. Sign in now.'));
    document.getElementById('resetTokenInput').value = '';
    document.getElementById('resetNewPassword').value = '';
    switchAuthMode('OWNER');
  } catch (_) {
    showToast('⚠️ Connection error.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

let staffRowCounter = 0;

function renderStaffRow(idx, defaultName = '', defaultPin = '') {
  const container = document.getElementById('regSalesmenContainer');
  if (!container) return;
  staffRowCounter += 1;
  const rowId = `staffRow_${staffRowCounter}`;
  const div = document.createElement('div');
  div.id = rowId;
  div.className = 'grid grid-cols-12 gap-2 items-center bg-white p-2 rounded-xl border border-slate-200/90 shadow-2xs';

  const nameCol = document.createElement('div');
  nameCol.className = 'col-span-7 flex flex-col';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'text-[10px] font-bold text-slate-500';
  nameLabel.textContent = `Staff #${idx} Name`;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'staff-name-input w-full bg-slate-50 border border-slate-200 text-slate-900 text-xs rounded-lg px-2 py-1 outline-none font-semibold';
  nameInput.placeholder = `e.g. Salesman ${idx}`;
  nameInput.value = defaultName || `Counter Staff ${idx}`;
  nameInput.required = true;
  nameCol.appendChild(nameLabel);
  nameCol.appendChild(nameInput);

  const pinCol = document.createElement('div');
  pinCol.className = 'col-span-4 flex flex-col';
  const pinLabel = document.createElement('label');
  pinLabel.className = 'text-[10px] font-bold text-slate-500';
  pinLabel.textContent = '4-Digit PIN';
  const pinInput = document.createElement('input');
  pinInput.type = 'password';
  pinInput.maxLength = 4;
  pinInput.inputMode = 'numeric';
  pinInput.className = 'staff-pin-input w-full bg-slate-50 border border-slate-200 text-slate-900 font-mono text-center text-xs rounded-lg px-2 py-1 outline-none font-bold tracking-widest';
  pinInput.placeholder = 'Choose PIN';
  pinInput.value = defaultPin;
  pinInput.required = true;
  pinCol.appendChild(pinLabel);
  pinCol.appendChild(pinInput);

  const removeCol = document.createElement('div');
  removeCol.className = 'col-span-1 flex items-end justify-center pt-3';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.dataset.removeRow = rowId;
  removeBtn.className = 'text-slate-400 hover:text-rose-500 text-xs cursor-pointer';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '✕';
  removeCol.appendChild(removeBtn);

  div.appendChild(nameCol);
  div.appendChild(pinCol);
  div.appendChild(removeCol);
  container.appendChild(div);
}

function adjustStaffRows(count) {
  const container = document.getElementById('regSalesmenContainer');
  if (!container) return;
  container.innerHTML = '';
  const num = Math.max(0, parseInt(count, 10) || 0);
  const defaultNames = ['Counter 1 (Main Desk)', 'Floor Sales (Lead)', 'Bridal Consultant', 'Floor Associate', 'Counter 2'];
  for (let i = 1; i <= num; i++) {
    renderStaffRow(i, defaultNames[i - 1] || `Sales Associate ${i}`, '');
  }
}

function addManualStaffRow() {
  const container = document.getElementById('regSalesmenContainer');
  if (!container) return;
  const currentRows = container.querySelectorAll('[id^="staffRow_"]').length;
  renderStaffRow(currentRows + 1, `Floor Staff ${currentRows + 1}`, '');
}

function removeStaffRow(rowId) {
  const el = document.getElementById(rowId);
  if (el) el.remove();
}

async function handleRegister() {
  const brandName = document.getElementById('regBrandName').value.trim();
  const ownerName = document.getElementById('regOwnerName').value.trim();
  const brandCategory = document.getElementById('regCategory').value;
  const phone = document.getElementById('regPhone').value.trim();
  const upiId = document.getElementById('regUpiId').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  const nameInputs = document.querySelectorAll('.staff-name-input');
  const pinInputs = document.querySelectorAll('.staff-pin-input');
  const salesmen = [];

  for (let i = 0; i < nameInputs.length; i++) {
    const name = nameInputs[i].value.trim();
    const pin = pinInputs[i].value.trim();
    if (!name) {
      showToast(`⚠️ Please enter a name for Staff #${i + 1}`);
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      showToast(`⚠️ PIN for ${name} must be exactly 4 digits (e.g. 1234)`);
      return;
    }
    salesmen.push({ name, pin });
  }

  const btn = document.getElementById('btnRegSubmit');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">refresh</span><span>Creating Store & Staff PINs on PaySap...</span>';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        brandName,
        ownerName,
        brandCategory,
        phone,
        upiId,
        email,
        password,
        salesmen
      })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast('⚠️ ' + (data.error || 'Registration failed.'));
      return;
    }

    localStorage.removeItem('auth_token');
    localStorage.setItem('auth_role', 'OWNER');
    localStorage.removeItem('seller_profile');
    localStorage.removeItem('salesman_profile');

    showToast(`🎉 ${data.seller.brandName} registered with ${salesmen.length} sales counters! Opening Store dashboard...`);
    setTimeout(() => {
      window.location.href = '/';
    }, 700);
  } catch (err) {
    console.error(err);
    showToast('⚠️ Connection error.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  adjustStaffRows(0);

  document.querySelectorAll('[data-auth-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchAuthMode(btn.dataset.authMode);
    });
  });

  document.getElementById('btnFindStore')?.addEventListener('click', loadPublicStores);
  document.getElementById('salesmanStoreSelect')?.addEventListener('change', e => onStoreSelectChange(e.target.value));
  document.getElementById('regEmployeeCount')?.addEventListener('change', e => adjustStaffRows(e.target.value));
  document.getElementById('btnAddStaffRow')?.addEventListener('click', addManualStaffRow);

  document.getElementById('regSalesmenContainer')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-row]');
    if (btn) removeStaffRow(btn.dataset.removeRow);
  });

  document.getElementById('salesmanForm')?.addEventListener('submit', e => {
    e.preventDefault();
    handleSalesmanLogin();
  });

  document.getElementById('ownerForm')?.addEventListener('submit', e => {
    e.preventDefault();
    handleOwnerLogin();
  });

  document.getElementById('registerForm')?.addEventListener('submit', e => {
    e.preventDefault();
    handleRegister();
  });

  document.getElementById('forgotPasswordForm')?.addEventListener('submit', e => {
    e.preventDefault();
    handleForgotPassword();
  });

  document.getElementById('resetPasswordForm')?.addEventListener('submit', e => {
    e.preventDefault();
    handleResetPassword();
  });

  const params = new URLSearchParams(location.search);
  const resetToken = params.get('resetToken') || '';
  const store = params.get('store') || localStorage.getItem('last_store_id') || '';
  const lookupInput = document.getElementById('staffStoreLookup');
  if (lookupInput) lookupInput.value = store;

  if (resetToken) {
    const tokenInput = document.getElementById('resetTokenInput');
    if (tokenInput) tokenInput.value = resetToken;
    switchAuthMode('RECOVERY');
  } else {
    switchAuthMode(store ? 'SALESMAN' : location.pathname === '/register' ? 'REGISTER' : 'OWNER');
    if (store) loadPublicStores();
  }
});

