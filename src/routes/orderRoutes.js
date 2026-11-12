const express = require('express');
const crypto = require('crypto');
const {
  sanitizeInput,
  generateCheckoutToken,
  sanitizePublicOrder,
  canManageOrder,
  hasCustomerSession,
  hasStockAccess,
  addOrderActivity,
  normalizeOrderSteps,
  isOrderClosed,
  amountInPaise,
  storeTheme
} = require('../utils/security');
const { extractToken } = require('../middleware/auth');
const { utrLimiter } = require('../middleware/rateLimit');
const {
  expireOrder,
  findCheckoutOrder,
  orderLinkResponse,
  resolveOrderLineItems,
  settleOrder,
  buildFunnel
} = require('../services/orderService');
const { emailAutoConfirmationEnabled, bankReceiptIssue } = require('../services/mailboxService');

function createOrderRoutes({ store, auth, triggerBankingPoller }) {
  const router = express.Router();

  router.post('/api/orders', auth.requireAuth, async (req, res, next) => {
    try {
      const {
        customerName = '',
        customerPhone = '',
        notes = '',
        internalNotes = '',
        customerNotes = '',
        customerInstructions = '',
        sku = '',
        saveToCatalog = false
      } = req.body;

      if (typeof saveToCatalog !== 'boolean') {
        return res.status(400).json({ error: 'Save to catalog must be true or false.' });
      }
      if (saveToCatalog && !hasStockAccess(req.seller)) {
        return res.status(403).json({ error: 'The owner must grant inventory editing access before you can save catalog items.' });
      }
      if ([customerName, customerPhone, notes, internalNotes, customerNotes, customerInstructions, sku].some(v => typeof v !== 'string')) {
        return res.status(400).json({ error: 'Sale details must be text values.' });
      }

      const staffNotes = sanitizeInput((internalNotes || notes || '').trim());
      const custInstructions = sanitizeInput((customerInstructions || customerNotes || '').trim());
      if (staffNotes.length > 5000 || custInstructions.length > 2000) {
        return res.status(400).json({ error: 'Notes exceed the maximum allowed length.' });
      }

      const seller = req.seller;
      const requestKey = req.get('Idempotency-Key') || req.body.clientRequestId || '';
      if (requestKey && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey))) {
        return res.status(400).json({ error: 'Invalid request key.' });
      }

      const txResult = await store.withTransaction(async tx => {
        const lineResult = await resolveOrderLineItems(tx, seller, req.body);
        if (lineResult.error) return { status: 400, error: lineResult.error };

        const requestDigest = crypto.createHash('sha256').update(JSON.stringify([
          lineResult.itemDescription,
          lineResult.items.map(i => [i.name, i.sku, i.quantity, i.unitPricePaise]),
          lineResult.discountPaise,
          lineResult.shippingPaise,
          lineResult.amountPaise,
          customerName,
          customerPhone,
          staffNotes,
          custInstructions,
          sku,
          Boolean(saveToCatalog),
          req.body.salesmanId || null,
          req.body.image || req.body.imageUrl || null,
          seller.currentSalesmanId || null
        ])).digest('hex');

        if (requestKey) {
          const previous = await tx.findOrderByClientRequestId(seller.id, requestKey);
          if (previous) {
            if (previous.requestDigest !== requestDigest || !canManageOrder(seller, previous)) {
              return { status: 409, error: 'This request key was already used for another sale. Start a new draft.' };
            }
            return { replay: true, order: previous };
          }
        }

        if (saveToCatalog && hasStockAccess(seller)) {
          const firstItem = lineResult.items[0];
          const existingProd = await tx.findMatchingProductForOrder(seller.id, { name: firstItem.name });
          if (!existingProd) {
            const autoSku = (firstItem.sku || firstItem.name.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase()).slice(0, 14);
            await tx.createProduct({
              id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              sku: autoSku,
              sellerId: seller.id,
              name: firstItem.name,
              category: seller.brandCategory || 'General Products',
              price: firstItem.unitPrice,
              stock: null,
              description: firstItem.name,
              notes: staffNotes,
              createdAt: new Date().toISOString()
            });
          }
        }

        const checkoutToken = generateCheckoutToken(seller.brandName);
        const { storeRef, invoiceId } = await tx.nextOrderIdentifiers(seller.id, seller.brandName);
        const cleanName = customerName.trim();
        const cleanPhone = customerPhone.replace(/\D/g, '').slice(-10);
        const payableAmt = lineResult.amountPaise / 100;
        const vpa = seller.upiId || 'store@upi';
        const upiIntentUrl = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(seller.brandName)}&am=${payableAmt.toFixed(2)}&cu=INR&tn=${encodeURIComponent('REF ' + storeRef + ' ' + checkoutToken)}&tr=${storeRef}`;

        const isSalesman = seller.currentRole === 'SALESMAN';
        const orderSalesmanId = isSalesman ? seller.currentSalesmanId : (req.body.salesmanId || null);
        const orderSalesmanName = isSalesman
          ? (seller.currentSalesmanName || 'Staff Desk')
          : (seller.currentRole === 'OWNER' ? 'Owner / Store Master' : 'Staff Desk');

        const newOrder = {
          token: checkoutToken,
          checkoutToken,
          ref: storeRef,
          storeRef,
          invoiceId,
          id: `ord_${checkoutToken}_${Date.now()}`,
          sellerId: seller.id,
          clientRequestId: requestKey || null,
          requestDigest: requestKey ? requestDigest : null,
          customerSessionKey: null,
          salesmanId: orderSalesmanId,
          salesmanName: orderSalesmanName,
          productId: lineResult.primaryProductId,
          sku: lineResult.primarySku,
          productImage: lineResult.primaryImage,
          brandName: seller.brandName,
          brandCategory: seller.brandCategory,
          ...storeTheme(seller),
          storeLocation: seller.storeLocation || null,
          storeInstagram: seller.storeInstagram || null,
          storeLogo: seller.storeLogo || null,
          assuranceText: seller.assuranceText || 'Payment goes directly to the store. Contact the store for delivery help.',
          storePhone: seller.phone || '',
          customerName: cleanName,
          customerPhone: cleanPhone,
          itemDescription: lineResult.itemDescription,
          items: lineResult.items,
          subtotalAmount: lineResult.subtotalPaise / 100,
          discountAmount: lineResult.discountPaise / 100,
          shippingAmount: lineResult.shippingPaise / 100,
          amount: payableAmt,
          amountPaise: lineResult.amountPaise,
          payableAmount: payableAmt,
          currency: 'INR',
          internalNotes: staffNotes,
          customerInstructions: custInstructions,
          notes: staffNotes,
          upiId: vpa,
          upiIntentUrl,
          status: 'PENDING',
          paymentStatus: 'AWAITING_PAYMENT',
          paymentMethod: null,
          paymentRef: null,
          utr: null,
          paidAt: null,
          createdAt: new Date().toISOString(),
          address: null,
          dispatchStatus: 'PENDING',
          trackingNumber: null,
          steps: {
            shared: { done: false, time: null },
            opened: { done: false, time: null },
            addressEntered: { done: false, time: null },
            redirectedToPayment: { done: false, time: null, app: null },
            paymentConfirmed: { done: false, time: null, utr: null, method: null },
            spreadsheetUpdated: { done: false, time: null, rowNumber: null, sheetName: 'Master Sales Sheet' }
          },
          currentStep: 'WAITING_FOR_USER'
        };

        await tx.createOrder(newOrder);
        return { order: newOrder };
      });

      if (txResult.error) return res.status(txResult.status).json({ error: txResult.error });
      if (txResult.replay) return res.json({ ...orderLinkResponse(txResult.order, req), replayed: true });
      return res.status(201).json(orderLinkResponse(txResult.order, req));
    } catch (err) {
      next(err);
    }
  });

  // Lightweight operational summary endpoint for dashboard polling
  router.get('/api/orders/summary', auth.requireAuth, async (req, res, next) => {
    try {
      const sellerId = req.seller.id;
      const isSalesman = req.seller.currentRole === 'SALESMAN';
      const currentSalesmanId = req.seller.currentSalesmanId;
      let storeOrders = await store.listOrdersBySeller(sellerId);
      if (isSalesman) {
        storeOrders = currentSalesmanId ? storeOrders.filter(o => o.salesmanId === currentSalesmanId) : [];
      }
      storeOrders.forEach(normalizeOrderSteps);
      const { funnel, paidCount, revenue } = buildFunnel(storeOrders);
      const reviewCredits = isSalesman ? [] : await store.listUnmatchedCredits(sellerId, 50);

      res.json({
        role: req.seller.currentRole || 'OWNER',
        metrics: {
          totalOrders: storeOrders.length,
          paidCount,
          revenue,
          pendingCount: storeOrders.filter(o => o.status === 'PENDING').length,
          dispatchedCount: storeOrders.filter(o => o.dispatchStatus === 'DISPATCHED').length,
          refundRequiredCount: storeOrders.filter(o => o.paymentStatus === 'REFUND_REQUIRED').length
        },
        funnel,
        unallocatedCreditsCount: reviewCredits.length
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/orders', auth.requireAuth, async (req, res, next) => {
    try {
      const { status, search, salesmanId, page, limit } = req.query;
      const sellerId = req.seller.id;
      const isSalesman = req.seller.currentRole === 'SALESMAN';
      const currentSalesmanId = req.seller.currentSalesmanId;

      const allStoreOrders = await store.listOrdersBySeller(sellerId);
      allStoreOrders.forEach(normalizeOrderSteps);

      let baseOrders = allStoreOrders;
      if (isSalesman) {
        baseOrders = currentSalesmanId ? allStoreOrders.filter(o => o.salesmanId === currentSalesmanId) : [];
      } else if (salesmanId && salesmanId !== 'ALL') {
        baseOrders = allStoreOrders.filter(o => o.salesmanId === salesmanId);
      }

      let filteredOrders = [...baseOrders];
      if (status && status !== 'ALL') {
        filteredOrders = filteredOrders.filter(o => o.status === status);
      }
      if (search) {
        const q = String(search).toLowerCase();
        filteredOrders = filteredOrders.filter(o =>
          (o.ref && o.ref.toLowerCase().includes(q)) ||
          (o.customerName && o.customerName.toLowerCase().includes(q)) ||
          (o.customerPhone && o.customerPhone.includes(q)) ||
          (o.itemDescription && o.itemDescription.toLowerCase().includes(q)) ||
          (o.utr && o.utr.toLowerCase().includes(q)) ||
          (o.salesmanName && o.salesmanName.toLowerCase().includes(q))
        );
      }

      const totalFiltered = filteredOrders.length;
      let pagination = null;
      if (limit !== undefined) {
        const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
        const totalPages = Math.max(1, Math.ceil(totalFiltered / safeLimit));
        const safePage = Math.min(totalPages, Math.max(1, parseInt(page, 10) || 1));
        const start = (safePage - 1) * safeLimit;
        filteredOrders = filteredOrders.slice(start, start + safeLimit);
        pagination = { page: safePage, limit: safeLimit, total: totalFiltered, totalPages };
      }

      const totalPaid = baseOrders.filter(o => o.status === 'PAID');
      const revenue = totalPaid.reduce((sum, o) => sum + parseFloat(o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0);
      const pendingOrders = baseOrders.filter(o => o.status === 'PENDING').length;
      const dispatchedOrders = baseOrders.filter(o => o.dispatchStatus === 'DISPATCHED').length;

      const responsePayload = {
        role: req.seller.currentRole || 'OWNER',
        orders: filteredOrders,
        ...(pagination ? { pagination } : {}),
        metrics: {
          totalOrders: baseOrders.length,
          paidCount: totalPaid.length,
          revenue,
          pendingCount: pendingOrders,
          dispatchedCount: dispatchedOrders
        }
      };

      if (isSalesman) {
        const { funnel, abandonedLeads } = buildFunnel(baseOrders);
        responsePayload.salesman = {
          id: currentSalesmanId,
          name: req.seller.currentSalesmanName
        };
        responsePayload.myFunnel = funnel;
        responsePayload.abandonedLeads = abandonedLeads;
      } else {
        const storeSalesmen = req.seller.salesmen || [];
        const breakdown = storeSalesmen.map(sm => {
          const smOrders = allStoreOrders.filter(o => o.salesmanId === sm.id);
          const { funnel, paidCount, revenue: smRev } = buildFunnel(smOrders);
          return {
            id: sm.id,
            name: sm.name,
            ...funnel,
            totalOrders: smOrders.length,
            paidOrders: paidCount,
            revenue: smRev,
            pendingOrders: smOrders.filter(o => o.status === 'PENDING').length
          };
        });
        const { funnel: overallFunnel, abandonedLeads } = buildFunnel(allStoreOrders);
        const credits = await store.listUnmatchedCredits(sellerId, 50);
        responsePayload.paymentReviewCredits = credits.map(c => ({
          id: c.id,
          amount: c.amount,
          utr: c.utr,
          receivedAt: c.receivedAt,
          authenticationVerified: c.authenticationVerified === true,
          reviewReason: c.reviewReason || 'REVIEW_REQUIRED'
        }));
        responsePayload.allSalesmen = storeSalesmen;
        responsePayload.salesmenBreakdown = breakdown;
        responsePayload.storeFunnel = overallFunnel;
        responsePayload.abandonedLeads = abandonedLeads;
      }

      res.json(responsePayload);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/orders/:tokenOrRef', async (req, res, next) => {
    try {
      const order = await findCheckoutOrder(store, auth.getSellerByToken, extractToken, req);
      if (!order) return res.status(404).json({ error: 'Order not found. Please check your link.' });

      await expireOrder(store, order);
      normalizeOrderSteps(order);

      const seller = await store.findSellerById(order.sellerId);
      if (!order.brandName) {
        if (seller) {
          order.brandName = seller.brandName;
          order.brandCategory = seller.brandCategory;
          order.upiId = order.upiId || seller.upiId;
        } else {
          order.brandName = 'Merchant Store';
          order.brandCategory = 'Retail & Goods';
        }
      }

      if (req.query.track !== 'false' && !order.steps.opened.done) {
        order.steps.opened = { done: true, time: new Date().toISOString() };
        if (order.currentStep === 'WAITING_FOR_USER') order.currentStep = 'LINK_OPENED';
        await store.saveOrder(order);
      }

      if (order.payableAmount === undefined) order.payableAmount = order.amount;

      const matchedProduct = await store.findMatchingProductForOrder(order.sellerId, {
        productId: order.productId,
        sku: order.sku,
        name: order.itemDescription
      });
      const isOutOfStock = Boolean(
        order.isOutOfStock ||
        (order.status === 'PENDING' && matchedProduct && typeof matchedProduct.stock === 'number' && matchedProduct.stock <= 0)
      );

      const authToken = extractToken(req);
      const authedSeller = authToken ? await auth.getSellerByToken(authToken) : null;
      const isInternalRequest = canManageOrder(authedSeller, order);
      const isCustomerOwner = hasCustomerSession(req, order);

      const storeBranding = {
        ...storeTheme(seller || order),
        storeLocation: (seller && seller.storeLocation) || order.storeLocation || null,
        storeInstagram: (seller && seller.storeInstagram) || order.storeInstagram || null,
        storeLogo: (seller && seller.storeLogo) || order.storeLogo || null,
        assuranceText: (seller && seller.assuranceText) || order.assuranceText || 'Payment goes directly to the store. Contact the store for delivery help.'
      };

      if (isInternalRequest) {
        const fullOrder = {
          ...order,
          ...storeBranding,
          productImage: (matchedProduct && matchedProduct.image) || order.productImage || null,
          sellerPhone: (seller && seller.phone) || order.sellerPhone || '',
          storePhone: (seller && seller.phone) || order.sellerPhone || '',
          isOutOfStock,
          currentStock: matchedProduct ? matchedProduct.stock : null
        };
        fullOrder.order = { ...fullOrder };
        return res.json(fullOrder);
      }

      const maskedOrder = sanitizePublicOrder({
        ...order,
        ...storeBranding,
        isOutOfStock,
        storePhone: (seller && seller.phone) || order.sellerPhone || '',
        productImage: (matchedProduct && matchedProduct.image) || order.productImage || null
      }, isCustomerOwner, seller);
      maskedOrder.order = { ...maskedOrder };
      res.json(maskedOrder);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/orders/:tokenOrRef/event', async (req, res, next) => {
    try {
      const order = await findCheckoutOrder(store, auth.getSellerByToken, extractToken, req);
      if (!order) return res.status(404).json({ error: 'Order not found.' });

      normalizeOrderSteps(order);
      const { event, app: appName } = req.body;
      let changed = false;

      if (event === 'LINK_OPENED') {
        if (!order.steps.opened.done) {
          order.steps.opened = { done: true, time: new Date().toISOString() };
          if (order.currentStep === 'WAITING_FOR_USER') order.currentStep = 'LINK_OPENED';
          changed = true;
        }
      } else if (event === 'REDIRECTED_TO_PAYMENT') {
        order.steps.redirectedToPayment = {
          done: true,
          time: new Date().toISOString(),
          app: appName || 'UPI Payment App'
        };
        if (order.status !== 'PAID') order.currentStep = 'REDIRECTED_TO_PAYMENT';
        changed = true;
        setTimeout(() => { triggerBankingPoller(); }, 1000);
      }

      if (changed) await store.saveOrder(order);
      const seller = await store.findSellerById(order.sellerId);
      res.json({ success: true, order: sanitizePublicOrder(order, hasCustomerSession(req, order), seller) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/orders/:tokenOrRef/address', async (req, res, next) => {
    try {
      const token = extractToken(req);
      const authedSeller = token ? await auth.getSellerByToken(token) : null;

      const result = await store.withTransaction(async tx => {
        const identifier = String(req.params.tokenOrRef || '').trim().toLowerCase();
        let existingOrder = await tx.findOrderByToken(identifier);
        if (!existingOrder && authedSeller) {
          const found = await tx.findOrderByIdentifier(identifier, authedSeller.id);
          if (found && canManageOrder(authedSeller, found)) existingOrder = found;
        }
        if (!existingOrder) return { status: 404, error: 'Order not found.' };

        const authorizedStaff = canManageOrder(authedSeller, existingOrder);
        if (await expireOrder(tx, existingOrder) || ['PACKED', 'DISPATCHED', 'SHIPPED', 'DELIVERED'].includes(existingOrder.dispatchStatus)) {
          return { status: 409, error: 'This address is locked. Contact the store for help changing delivery details.' };
        }
        if ((existingOrder.customerSessionKey || existingOrder.address) && !hasCustomerSession(req, existingOrder) && !authorizedStaff) {
          return { status: 403, error: 'Use the device that saved this address, or contact the store to change it.' };
        }

        const { fullName, phone, flat, street, landmark = '', pincode, city, state } = req.body;
        if ([fullName, phone, flat, street || '', landmark, pincode, city, state].some(v => typeof v !== 'string') ||
            !fullName.trim() || !phone || !flat.trim() || !pincode || !city.trim() || !state.trim() ||
            [fullName, flat, street || '', landmark, city, state].some(v => v.length > 500)) {
          return { status: 400, error: 'Please fill in all mandatory address fields.' };
        }

        const cleanPhone = phone.replace(/\D/g, '').slice(-10);
        const cleanPincode = pincode.replace(/\D/g, '');
        if (cleanPhone.length < 10) return { status: 400, error: 'Please enter a valid 10-digit mobile number.' };
        if (cleanPincode.length !== 6) return { status: 400, error: 'Please enter a valid 6-digit postal PIN code.' };

        normalizeOrderSteps(existingOrder);
        existingOrder.address = {
          fullName: sanitizeInput(fullName.trim()),
          phone: cleanPhone,
          flat: sanitizeInput(flat.trim()),
          street: sanitizeInput((street || '').trim()),
          landmark: sanitizeInput((landmark || '').trim()),
          pincode: cleanPincode,
          city: sanitizeInput(city.trim()),
          state: sanitizeInput(state.trim())
        };
        existingOrder.customerName = sanitizeInput(fullName.trim());
        existingOrder.customerPhone = cleanPhone;
        existingOrder.steps.addressEntered = { done: true, time: new Date().toISOString() };
        if (existingOrder.status === 'PENDING') existingOrder.currentStep = 'ADDRESS_ENTERED';
        if (!existingOrder.customerSessionKey) existingOrder.customerSessionKey = crypto.randomBytes(16).toString('hex');

        await tx.saveOrder(existingOrder);
        const seller = await tx.findSellerById(existingOrder.sellerId);
        return { order: existingOrder, seller };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({
        success: true,
        message: 'Shipping address saved successfully.',
        customerSessionKey: result.order.customerSessionKey,
        order: sanitizePublicOrder(result.order, true, result.seller)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/orders/:tokenOrRef/utr', utrLimiter, async (req, res, next) => {
    try {
      const cleanUtr = typeof req.body.utr === 'string' ? req.body.utr.trim() : '';
      if (!/^\d{12}$/.test(cleanUtr)) {
        return res.status(400).json({ error: 'Please enter the 12-digit UPI reference number.' });
      }
      const token = extractToken(req);
      const authedSeller = token ? await auth.getSellerByToken(token) : null;

      const result = await store.withTransaction(async tx => {
        const identifier = String(req.params.tokenOrRef || '').trim().toLowerCase();
        let order = await tx.findOrderByToken(identifier);
        if (!order && authedSeller) {
          const found = await tx.findOrderByIdentifier(identifier, authedSeller.id);
          if (found && canManageOrder(authedSeller, found)) order = found;
        }
        if (!order) return { status: 404, error: 'Order not found.' };
        const seller = await tx.findSellerById(order.sellerId);
        const isOwnerSession = hasCustomerSession(req, order);

        if (await expireOrder(tx, order)) {
          return { status: 409, error: 'This order is closed. Contact the store if you have already paid.' };
        }
        if (order.status === 'PAID') {
          return { status: 200, verified: true, order, seller, isOwnerSession };
        }
        const duplicatePaid = await tx.findPaidOrderByUtr(order.sellerId, cleanUtr, order.id);
        if (duplicatePaid) {
          return { status: 409, error: 'This reference has already been allocated. Contact the store for help.' };
        }

        order.customerReportedUtr = cleanUtr;
        order.customerReportedAt = new Date().toISOString();
        order.paymentStatus = 'AWAITING_CONFIRMATION';

        const credit = await tx.findUnmatchedCredit({ sellerId: order.sellerId, utr: cleanUtr, unallocatedOnly: true });
        if (credit &&
            credit.authenticationVerified === true &&
            amountInPaise(credit.amount) === amountInPaise(order.payableAmount ?? order.amount) &&
            emailAutoConfirmationEnabled(seller) &&
            !(await bankReceiptIssue(tx, order, credit)) &&
            await settleOrder(tx, order, {
              utr: cleanUtr,
              method: 'Direct UPI (Bank Alert + Customer Reference)',
              via: 'bank_email_matched_by_utr',
              reason: 'Authenticated bank credit matched customer reference'
            })) {
          credit.allocatedOrderId = order.id || order.token;
          await tx.saveUnmatchedCredit(credit);
          return { status: 200, verified: true, order, seller, isOwnerSession };
        }

        if (order.fulfillmentIssue) order.paymentStatus = 'REVIEW_REQUIRED';
        addOrderActivity(order, 'PAYMENT_REPORTED', 'customer');
        await tx.saveOrder(order);
        return { status: 202, verified: false, order, seller, isOwnerSession };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      if (result.verified) {
        return res.json({
          success: true,
          verified: true,
          order: sanitizePublicOrder(result.order, result.isOwnerSession, result.seller)
        });
      }
      if (process.env.DISABLE_BANK_POLLING !== '1') {
        setTimeout(() => { triggerBankingPoller(); }, 500);
      }
      return res.status(202).json({
        success: true,
        verified: false,
        status: result.order.paymentStatus,
        message: 'Payment reported. The store will confirm receipt. Do not pay again.',
        order: sanitizePublicOrder(result.order, result.isOwnerSession, result.seller)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/orders/:tokenOrRef/mark-paid', auth.requireOwner, async (req, res, next) => {
    try {
      const utr = typeof req.body.utr === 'string' ? req.body.utr.trim() : '';
      const method = req.body.paymentMethod || 'Manual Bank Verification / Cash';
      if ((utr && !/^\d{12}$/.test(utr)) || typeof method !== 'string' || method.length > 100) {
        return res.status(400).json({ error: 'Provide a valid payment method and, if available, a 12-digit UPI reference.' });
      }

      const result = await store.withTransaction(async tx => {
        const order = await tx.findOrderByIdentifier(req.params.tokenOrRef, req.seller.id);
        if (!order) return { status: 404, error: 'Order not found.' };
        if (await expireOrder(tx, order)) {
          return { status: 409, error: 'Closed orders cannot be marked paid. Review the payment separately.' };
        }
        if (order.status === 'PAID') return { status: 200, order };

        if (utr) {
          const existingPaid = await tx.findPaidOrderByUtr(order.sellerId, utr, order.id);
          if (existingPaid) return { status: 409, error: 'This reference has already been allocated to a paid order.' };
        }

        const settled = await settleOrder(tx, order, {
          utr: utr || null,
          method: sanitizeInput(method),
          via: 'admin_manual',
          actor: req.seller.id,
          reason: sanitizeInput(String(req.body.reason || 'Owner confirmed payment receipt').slice(0, 1000))
        });
        if (!settled) {
          return { status: 409, error: 'This item is out of stock. Resolve availability before confirming fulfilment.', order };
        }

        if (utr) {
          const receipt = await tx.findUnmatchedCredit({ sellerId: order.sellerId, utr, unallocatedOnly: true });
          if (receipt && amountInPaise(receipt.amount) === amountInPaise(order.payableAmount ?? order.amount)) {
            receipt.allocatedOrderId = order.id || order.token;
            receipt.reviewReason = null;
            receipt.reviewedBy = req.seller.id;
            await tx.saveUnmatchedCredit(receipt);
          }
        }
        return { status: 200, order };
      });

      if (result.error) return res.status(result.status).json({ error: result.error, ...(result.order ? { order: result.order } : {}) });
      res.json({ success: true, message: 'Payment confirmed by store owner.', order: result.order });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/orders/:tokenOrRef/dispatch', auth.requireAuth, async (req, res, next) => {
    try {
      const result = await store.withTransaction(async tx => {
        const order = await tx.findOrderByIdentifier(req.params.tokenOrRef, req.seller.id);
        if (!order) return { status: 404, error: 'Order not found.' };
        if (!canManageOrder(req.seller, order)) return { status: 403, error: 'You can only update your own sales.' };

        const current = order.dispatchStatus || 'PENDING';
        const target = req.body.status ? String(req.body.status).toUpperCase().trim() : current;
        const allowed = {
          PENDING: ['PACKING', 'CANCELLED'],
          PACKING: ['PACKED', 'DISPATCHED', 'CANCELLED'],
          PACKED: ['DISPATCHED', 'CANCELLED'],
          DISPATCHED: ['DELIVERED'],
          DELIVERED: [],
          CANCELLED: []
        };
        if (!allowed[target] || (target !== current && !(allowed[current] || []).includes(target))) {
          return { status: 409, error: 'This dispatch transition is not allowed.' };
        }
        if (!['PENDING', 'CANCELLED'].includes(target) && (order.status !== 'PAID' || isOrderClosed(order))) {
          return { status: 409, error: 'Confirm payment before preparing or shipping this order.' };
        }
        if (['PACKED', 'DISPATCHED', 'DELIVERED'].includes(target) && !order.address) {
          return { status: 409, error: 'Save a delivery address before completing this step.' };
        }
        if (target === 'CANCELLED' && req.seller.currentRole !== 'OWNER') {
          return { status: 403, error: 'Only the store owner can cancel an order.' };
        }
        const tracking = req.body.trackingNumber;
        if (tracking !== undefined && (typeof tracking !== 'string' || tracking.length > 150)) {
          return { status: 400, error: 'Enter a valid tracking number.' };
        }
        if (target === 'DISPATCHED' && !(typeof tracking === 'string' ? tracking.trim() : order.trackingNumber)) {
          return { status: 409, error: 'Add the courier tracking number before marking this order shipped.' };
        }

        if (target === 'CANCELLED' && target !== current) {
          order.cancelledAt = new Date().toISOString();
          if (order.status === 'PAID') order.paymentStatus = 'REFUND_REQUIRED';
          else {
            order.status = 'CANCELLED';
            order.paymentStatus = 'CANCELLED';
          }
        }
        order.dispatchStatus = target;
        if (tracking !== undefined) order.trackingNumber = sanitizeInput(tracking.trim());
        addOrderActivity(order, 'DISPATCH_UPDATED', req.seller.currentSalesmanId || req.seller.id, { from: current, to: target });
        await tx.saveOrder(order);
        return { status: 200, order };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ success: true, order: result.order });
    } catch (err) {
      next(err);
    }
  });

  // Owner-only refund resolution logging for cancelled paid orders
  router.post('/api/orders/:tokenOrRef/refund', auth.requireOwner, async (req, res, next) => {
    try {
      const { amount, method = 'UPI Refund', reference = '', notes = '' } = req.body;
      if (typeof method !== 'string' || !method.trim() || method.length > 100 ||
          typeof reference !== 'string' || reference.length > 100 ||
          typeof notes !== 'string' || notes.length > 1000) {
        return res.status(400).json({ error: 'Provide a valid refund method, reference, and notes.' });
      }

      const result = await store.withTransaction(async tx => {
        const order = await tx.findOrderByIdentifier(req.params.tokenOrRef, req.seller.id);
        if (!order) return { status: 404, error: 'Order not found.' };
        if (order.status !== 'PAID' || order.paymentStatus !== 'REFUND_REQUIRED') {
          return { status: 409, error: 'Only cancelled paid orders marked for refund can record a refund.' };
        }
        const paidPaise = amountInPaise(order.payableAmount ?? order.amount);
        const refundPaise = amount !== undefined ? amountInPaise(amount) : paidPaise;
        if (refundPaise === null || refundPaise > paidPaise) {
          return { status: 400, error: 'Refund amount must be positive and cannot exceed the paid order amount.' };
        }

        const isPartial = refundPaise < paidPaise;
        order.paymentStatus = isPartial ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
        order.refundDetails = {
          status: order.paymentStatus,
          amount: refundPaise / 100,
          amountPaise: refundPaise,
          method: sanitizeInput(method.trim()),
          reference: sanitizeInput(reference.trim()),
          notes: sanitizeInput(notes.trim()),
          recordedBy: req.seller.id,
          refundedAt: new Date().toISOString()
        };
        addOrderActivity(order, 'REFUND_RECORDED', req.seller.id, {
          amount: order.refundDetails.amount,
          method: order.refundDetails.method,
          partial: isPartial
        });
        await tx.saveOrder(order);
        return { status: 200, order };
      });

      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ success: true, message: 'Refund recorded on order.', order: result.order });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOrderRoutes };

