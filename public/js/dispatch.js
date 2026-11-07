// PaySap Dispatch Board JavaScript (Fulfillment & Shipping)
document.addEventListener('DOMContentLoaded', () => {
  const tableBody = document.getElementById('ordersTableBody');
  const metricRevenue = document.getElementById('metricRevenue');
  const metricPaid = document.getElementById('metricPaid');
  const metricPending = document.getElementById('metricPending');
  const metricDispatched = document.getElementById('metricDispatched');

  const filterButtons = document.querySelectorAll('.dispatch-filter');
  const searchInput = document.getElementById('searchInput');
  const btnRefresh = document.getElementById('btnRefresh');

  let currentStatusFilter = 'ALL';
  let searchQuery = '';
  let cachedOrders = [];

  // Filter Buttons
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => {
        b.className = 'dispatch-filter px-3 py-1 rounded-full bg-white hover:bg-slate-100 text-slate-600 text-xs font-semibold border border-slate-200 transition-colors cursor-pointer';
      });
      btn.className = 'dispatch-filter px-3 py-1 rounded-full bg-slate-900 text-white text-xs font-semibold shadow-xs cursor-pointer';
      currentStatusFilter = btn.dataset.status;
      renderTable();
    });
  });

  // Search Filter
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderTable();
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchOrders(true);
    });
  }

  function getAuthHeaders(extra = {}) {
    const token = localStorage.getItem('auth_token') || '';
    const headers = { ...extra };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-auth-token'] = token;
    }
    return headers;
  }

  // Fetch Orders
  async function fetchOrders(showToastOnRefresh = false) {
    try {
      const res = await fetch('/api/orders', {
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        window.location.href = '/auth';
        return;
      }
      if (!res.ok) throw new Error('Failed to load orders');
      const data = await res.json();
      
      if (data.role === 'SALESMAN') {
        alert('Access denied. Master fulfillment dispatch board is restricted to Store Owners.');
        window.location.href = '/';
        return;
      }

      cachedOrders = data.orders || [];
      const m = data.metrics || {};

      if (metricRevenue) metricRevenue.textContent = `₹${(m.revenue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (metricPaid) metricPaid.textContent = m.paidCount || 0;
      if (metricPending) metricPending.textContent = m.pendingCount || 0;
      if (metricDispatched) metricDispatched.textContent = m.dispatchedCount || 0;

      renderTable();

      if (showToastOnRefresh) {
        showToast('🔄 Dispatch sheet refreshed');
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Render Table
  function renderTable() {
    if (!tableBody) return;
    let list = [...cachedOrders];

    if (currentStatusFilter !== 'ALL') {
      list = list.filter(o => o.status === currentStatusFilter);
    }

    if (searchQuery) {
      list = list.filter(o => 
        (o.ref || '').toLowerCase().includes(searchQuery) ||
        (o.customerName || '').toLowerCase().includes(searchQuery) ||
        (o.customerPhone || '').includes(searchQuery) ||
        (o.itemDescription || '').toLowerCase().includes(searchQuery) ||
        (o.utr && o.utr.toLowerCase().includes(searchQuery))
      );
    }

    if (list.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="9" class="py-12 px-4 text-center">
            <div class="flex flex-col items-center justify-center gap-2">
              <span class="material-symbols-outlined text-[32px] text-slate-300">receipt_long</span>
              <p class="text-xs font-semibold text-slate-500">No orders found.</p>
              <a href="/" class="mt-1 px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold text-xs rounded-xl border border-indigo-100 transition-colors inline-flex items-center gap-1 no-underline">
                <span class="material-symbols-outlined text-[15px]">add</span>
                <span>Create New Sale Link</span>
              </a>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = list.map(order => {
      const isPaid = order.status === 'PAID';
      const cleanName = (order.customerName || '').trim();
      const name = cleanName || `#REF-${order.ref}`;
      const initials = cleanName 
        ? cleanName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() 
        : `#${order.ref}`;
      const addr = order.address || {};
      const fullAddressString = [
        addr.flat,
        addr.street,
        addr.landmark,
        addr.city,
        addr.state
      ].filter(Boolean).join(', ') || '<span class="text-slate-400 italic">Address pending</span>';

      const statusBadge = isPaid
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold border border-emerald-200">
             <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Paid
           </span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-bold border border-amber-200">
             <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> In Progress
           </span>`;

      const avatarBg = isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700';
      const waChatUrl = order.customerPhone ? `https://wa.me/91${order.customerPhone}` : '#';
      const origin = window.location.origin;
      const payUrl = `${origin}/pay?ref=${order.ref}`;
      const payableAmt = (order.payableAmount !== undefined ? order.payableAmount : order.amount).toFixed(2);

      return `
        <tr class="hover:bg-slate-50/70 transition-colors">
          <td class="py-3.5 px-4 whitespace-nowrap">
            <a href="${payUrl}" target="_blank" class="font-bold text-indigo-600 hover:text-indigo-800 text-xs font-mono">
              #${order.ref} ↗
            </a>
          </td>
          <td class="py-3.5 px-4">
            <div class="flex items-center gap-2.5">
              <div class="w-7 h-7 rounded-full ${avatarBg} font-bold flex items-center justify-center text-xs shrink-0">${initials}</div>
              <div>
                <span class="font-bold text-slate-900 block">${escapeHtml(name)}</span>
                ${order.customerPhone ? `
                  <a href="${waChatUrl}" target="_blank" class="text-[11px] text-emerald-600 hover:underline flex items-center gap-0.5 font-medium">
                    <span class="material-symbols-outlined text-[12px]">chat</span>
                    <span>+91 ${order.customerPhone}</span>
                  </a>
                ` : '<span class="text-[11px] text-slate-400">-</span>'}
              </div>
            </div>
          </td>
          <td class="py-3.5 px-4 max-w-xs truncate text-slate-800">
            <div>${escapeHtml(order.itemDescription)}</div>
            ${order.notes ? `<div class="text-[10px] text-indigo-600 mt-0.5">Note: ${escapeHtml(order.notes)}</div>` : ''}
          </td>
          <td class="py-3.5 px-4 font-bold text-slate-900 whitespace-nowrap">
            ₹${payableAmt}
          </td>
          <td class="py-3.5 px-4">
            ${statusBadge}
            ${isPaid ? `
              <div class="font-mono text-[10px] text-indigo-700 mt-1 truncate max-w-[130px] font-bold">${order.utr || order.paymentRef}</div>
              ${order.matchReason ? `<div class="text-[9px] text-slate-400">${escapeHtml(order.matchReason)}</div>` : ''}
            ` : ''}
          </td>
          <td class="py-3.5 px-4 max-w-xs text-[11px] text-slate-600 leading-snug">
            ${fullAddressString}
          </td>
          <td class="py-3.5 px-4 font-semibold text-slate-800 whitespace-nowrap">
            ${addr.pincode || '<span class="text-slate-400 font-normal">-</span>'}
          </td>
          <td class="py-3.5 px-4 whitespace-nowrap">
            <select class="dispatch-select bg-white border border-slate-200 text-slate-700 text-[11px] font-semibold rounded-lg px-2 py-1 outline-none" data-ref="${order.ref}">
              <option value="PENDING" ${order.dispatchStatus === 'PENDING' ? 'selected' : ''}>⏳ Pending</option>
              <option value="PACKED" ${order.dispatchStatus === 'PACKED' || order.dispatchStatus === 'PACKING' ? 'selected' : ''}>📦 Packed</option>
              <option value="DISPATCHED" ${order.dispatchStatus === 'DISPATCHED' ? 'selected' : ''}>🚚 Dispatched</option>
            </select>
          </td>
          <td class="py-3.5 px-4 text-right whitespace-nowrap">
            <div class="flex items-center justify-end gap-1.5">
              ${!isPaid ? `
                <button type="button" class="mark-paid-quick px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg text-[11px] font-bold transition-all cursor-pointer" data-ref="${order.ref}" title="Mark Paid Manually">
                  Mark Paid
                </button>
              ` : `
                <span class="text-emerald-600 font-bold text-[11px] flex items-center gap-0.5 justify-end">
                  <span class="material-symbols-outlined text-[14px]">done_all</span> Verified
                </span>
              `}
              <button type="button" onclick="copyToClipboard('${payUrl}')" class="p-1 hover:bg-slate-100 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer" title="Copy Link">
                <span class="material-symbols-outlined text-[15px]">content_copy</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach dispatch select listener
    document.querySelectorAll('.dispatch-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const ref = e.target.dataset.ref;
        const newStatus = e.target.value;
        try {
          const res = await fetch(`/api/orders/${ref}/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dispatchStatus: newStatus })
          });
          if (res.ok) {
            showToast(`Order #${ref} updated to ${newStatus}`);
            fetchOrders();
          }
        } catch (err) {
          console.error(err);
        }
      });
    });

    // Attach mark paid listener (calls real admin manual mark endpoint)
    document.querySelectorAll('.mark-paid-quick').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const ref = btn.dataset.ref;
        if (!confirm(`Mark Order #${ref} as PAID manually?`)) return;
        try {
          const res = await fetch(`/api/orders/${ref}/mark-paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentMethod: 'Manual Bank Verification / Cash' })
          });
          if (res.ok) {
            showToast(`🟢 Order #${ref} marked as PAID!`);
            fetchOrders();
          }
        } catch (err) {
          console.error(err);
        }
      });
    });
  }

  // Initial load
  fetchOrders();

  // Auto-refresh every 5s
  setInterval(() => {
    fetchOrders(false);
  }, 5000);
});

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("Payment link copied to clipboard!");
  });
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
  }, 2600);
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
