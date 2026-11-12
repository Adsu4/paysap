const express = require('express');
const path = require('path');
const { PINCODE_CACHE } = require('../config/env');

function createUtilityRoutes({ store, auth, publicDir }) {
  const router = express.Router();

  router.get('/api/pincode/:pincode', async (req, res) => {
    const pin = req.params.pincode ? req.params.pincode.trim() : '';
    if (!/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, error: 'Invalid 6-digit Indian pincode' });
    }
    const cached = PINCODE_CACHE[pin];
    if (cached) return res.json({ success: true, data: cached });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const apiRes = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (Array.isArray(data) && data[0] && data[0].Status === 'Success' && Array.isArray(data[0].PostOffice) && data[0].PostOffice.length > 0) {
          const po = data[0].PostOffice[0];
          const result = {
            city: po.District || po.Division || po.Block || po.Circle,
            state: po.State,
            area: po.Name
          };
          PINCODE_CACHE[pin] = result;
          return res.json({ success: true, data: result });
        }
      }
    } catch (err) {
      console.warn(`Pincode live lookup failed for ${pin}:`, err.message);
    }

    return res.status(503).json({
      success: false,
      error: 'City and state lookup is unavailable. Enter both manually; your address can still be saved.'
    });
  });

  router.get('/api/export/csv', auth.requireAuth, async (req, res, next) => {
    try {
      let exportOrders = await store.listOrdersBySeller(req.seller.id);
      if (req.seller.currentRole === 'SALESMAN') {
        exportOrders = exportOrders.filter(o => o.salesmanId === req.seller.currentSalesmanId);
      }

      const headers = [
        'Sheet Row', 'Order Ref', 'Date Created', 'Paid At', 'Customer Name', 'Customer Mobile',
        'Item Description', 'Base Amount (INR)', 'Payable Amount (INR)', 'Payment Status',
        'Bank UTR', 'Verification Mode', 'Flat/House', 'Street', 'Landmark', 'City', 'State',
        'Pincode', 'Dispatch Status', 'Tracking Number'
      ];

      function escapeCsvCell(val) {
        if (val === null || val === undefined) return '""';
        let s = String(val).replace(/"/g, '""');
        if (/^[=\+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s}"`;
      }

      const rows = exportOrders.map((o, idx) => {
        const a = o.address || {};
        return [
          escapeCsvCell(`Row #${idx + 2}`),
          escapeCsvCell(`REF-${o.ref}`),
          escapeCsvCell(o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN') : ''),
          escapeCsvCell(o.paidAt ? new Date(o.paidAt).toLocaleString('en-IN') : ''),
          escapeCsvCell(o.customerName || ''),
          escapeCsvCell(o.customerPhone || ''),
          escapeCsvCell(o.itemDescription || ''),
          escapeCsvCell(o.amount || ''),
          escapeCsvCell(o.payableAmount || o.amount || ''),
          escapeCsvCell(o.status || ''),
          escapeCsvCell(o.utr || ''),
          escapeCsvCell(o.paymentMethod || o.verifiedVia || ''),
          escapeCsvCell(a.flat || ''),
          escapeCsvCell(a.street || ''),
          escapeCsvCell(a.landmark || ''),
          escapeCsvCell(a.city || ''),
          escapeCsvCell(a.state || ''),
          escapeCsvCell(a.pincode || ''),
          escapeCsvCell(o.dispatchStatus || 'PENDING'),
          escapeCsvCell(o.trackingNumber || '')
        ].join(',');
      });

      const csvContent = [headers.join(','), ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="master_sales_sheet_${Date.now()}.csv"`);
      res.send(csvContent);
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth', (req, res) => res.sendFile('auth.html', { root: publicDir }));
  router.get('/login', (req, res) => res.sendFile('auth.html', { root: publicDir }));
  router.get('/register', (req, res) => res.sendFile('auth.html', { root: publicDir }));
  router.get('/pay', (req, res) => res.sendFile('pay.html', { root: publicDir }));
  router.get('/dispatch', (req, res) => res.redirect(302, '/?tab=dispatch'));
  router.get('/', (req, res) => res.sendFile('index.html', { root: publicDir }));

  router.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  router.get('/readyz', async (req, res) => {
    try {
      await store.readyCheck();
      res.json({ status: 'ready' });
    } catch (_) {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}

module.exports = { createUtilityRoutes };

