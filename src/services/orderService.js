const crypto = require('crypto');
const {
  sanitizeInput,
  amountInPaise,
  nonNegativePaise,
  isOrderClosed,
  addOrderActivity,
  normalizeOrderSteps,
  canManageOrder
} = require('../utils/security');

async function expireOrder(store, order) {
  if (order.status === 'PENDING' && order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) {
    order.status = 'EXPIRED';
    order.paymentStatus = 'EXPIRED';
    await store.saveOrder(order);
  }
  return isOrderClosed(order);
}

async function findCheckoutOrder(store, getSellerByToken, extractToken, req) {
  const identifier = String(req.params.tokenOrRef || '').trim().toLowerCase();
  const tokenOrder = await store.findOrderByToken(identifier);
  if (tokenOrder) return tokenOrder;
  const seller = await getSellerByToken(extractToken(req));
  if (!seller) return null;
  const order = await store.findOrderByIdentifier(identifier, seller.id);
  return order && canManageOrder(seller, order) ? order : null;
}

function orderLinkResponse(order, req) {
  const origin = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const payUrl = `${origin}/pay?token=${encodeURIComponent(order.token)}`;
  const greeting = order.customerName ? `Hi ${order.customerName.split(' ')[0]}!` : 'Hello!';
  const formattedPrice = `₹${Number(order.payableAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const whatsappPitch = `${greeting}\n\nYour order for *${order.itemDescription}* (${formattedPrice}) with ${order.brandName} is ready.\n\nConfirm your delivery address and pay the store directly:\n${payUrl}`;
  const phone = String(order.customerPhone || '').replace(/\D/g, '').slice(-10);
  return {
    success: true,
    order,
    payUrl,
    checkoutUrl: payUrl,
    checkoutToken: order.token,
    whatsappPitch,
    waLink: `https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(whatsappPitch)}`
  };
}

async function resolveOrderLineItems(store, seller, body) {
  const rawItems = Array.isArray(body.items) ? body.items : null;
  const discountPaise = nonNegativePaise(body.discountAmount ?? 0);
  const shippingPaise = nonNegativePaise(body.shippingAmount ?? 0);
  if (discountPaise === null || shippingPaise === null) {
    return { error: 'Discount and shipping charges must be valid non-negative amounts with at most 2 decimals.' };
  }

  if (rawItems && rawItems.length > 0) {
    if (rawItems.length > 50) return { error: 'An order can contain at most 50 line items.' };
    const normalizedItems = [];
    let subtotalPaise = 0;

    for (const entry of rawItems) {
      if (!entry || typeof entry !== 'object') return { error: 'Each line item must be an object.' };
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const sku = typeof entry.sku === 'string' ? entry.sku.trim() : '';
      const productId = typeof entry.productId === 'string' ? entry.productId.trim() : '';
      const qty = Number(entry.quantity ?? 1);
      if (!name || name.length > 250 || !Number.isSafeInteger(qty) || qty < 1 || qty > 1000) {
        return { error: 'Each line item needs a name and a whole quantity between 1 and 1000.' };
      }
      const unitPaise = amountInPaise(entry.unitPrice ?? entry.price);
      if (unitPaise === null) {
        return { error: `Line item "${name}" needs a positive unit price with at most 2 decimals.` };
      }
      const matched = await store.findMatchingProductForOrder(seller.id, { productId, sku, name });
      if (matched && typeof matched.stock === 'number' && matched.stock < qty) {
        return {
          error: `"${matched.name}" only has ${matched.stock} unit(s) available (requested ${qty}).`
        };
      }
      const lineTotalPaise = unitPaise * qty;
      subtotalPaise += lineTotalPaise;
      normalizedItems.push({
        productId: matched ? matched.id : (productId || null),
        sku: sku || (matched ? matched.sku : '') || '',
        name: sanitizeInput(name),
        quantity: qty,
        unitPrice: unitPaise / 100,
        unitPricePaise: unitPaise,
        lineTotal: lineTotalPaise / 100,
        lineTotalPaise,
        image: (matched && matched.image) || entry.image || null
      });
    }

    const totalPaise = subtotalPaise - discountPaise + shippingPaise;
    if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0 || totalPaise > 10000000000) {
      return { error: 'Order total after discount and shipping must be positive.' };
    }

    const summaryDesc = normalizedItems.length === 1
      ? (normalizedItems[0].quantity > 1 ? `${normalizedItems[0].name} × ${normalizedItems[0].quantity}` : normalizedItems[0].name)
      : `${normalizedItems[0].name} + ${normalizedItems.length - 1} more item${normalizedItems.length > 2 ? 's' : ''}`;

    return {
      items: normalizedItems,
      itemDescription: summaryDesc.slice(0, 500),
      primaryProductId: normalizedItems[0].productId,
      primarySku: normalizedItems[0].sku || null,
      primaryImage: normalizedItems.find(i => i.image)?.image || null,
      subtotalPaise,
      discountPaise,
      shippingPaise,
      amountPaise: totalPaise
    };
  }

  // Legacy single-item payload compatibility
  const rawDesc = body.itemDescription || body.itemDesc || '';
  if (typeof rawDesc !== 'string') return { error: 'Sale details must be text values.' };
  const desc = rawDesc.trim();
  const unitPaise = amountInPaise(body.amount);
  const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
  if (unitPaise === null || !desc || desc.length > 500) {
    return { error: 'Enter an item description and a positive amount with at most 2 decimal places.' };
  }

  const matchedProduct = await store.findMatchingProductForOrder(seller.id, { sku, name: desc });
  if (matchedProduct && typeof matchedProduct.stock === 'number' && matchedProduct.stock <= 0) {
    return {
      error: `"${matchedProduct.name}" is currently OUT OF STOCK (0 units available). Stock access permission is required to replenish this item before an order link can be created.`
    };
  }

  const totalPaise = unitPaise - discountPaise + shippingPaise;
  if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0 || totalPaise > 10000000000) {
    return { error: 'Order total after discount and shipping must be positive.' };
  }

  return {
    items: [{
      productId: matchedProduct ? matchedProduct.id : null,
      sku: sku || (matchedProduct ? matchedProduct.sku : '') || '',
      name: sanitizeInput(desc),
      quantity: 1,
      unitPrice: unitPaise / 100,
      unitPricePaise: unitPaise,
      lineTotal: unitPaise / 100,
      lineTotalPaise: unitPaise,
      image: (matchedProduct && matchedProduct.image) || body.image || body.imageUrl || null
    }],
    itemDescription: desc,
    primaryProductId: matchedProduct ? matchedProduct.id : null,
    primarySku: sku || (matchedProduct ? matchedProduct.sku : null),
    primaryImage: (matchedProduct && matchedProduct.image) || body.image || body.imageUrl || null,
    subtotalPaise: unitPaise,
    discountPaise,
    shippingPaise,
    amountPaise: totalPaise
  };
}

async function resolveOrderItemProducts(store, order) {
  const items = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : [{ productId: order.productId, sku: order.sku, name: order.itemDescription, quantity: 1 }];
  const resolved = [];
  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const product = await store.findMatchingProductForOrder(order.sellerId, {
      productId: item.productId,
      sku: item.sku,
      name: item.name
    });
    resolved.push({ item, qty, product });
  }
  return resolved;
}

async function decrementProductStockOnPayment(store, order) {
  if (!order || order.stockDecremented) return null;
  const resolved = await resolveOrderItemProducts(store, order);
  let primaryProduct = null;

  // Verify stock availability across all items before decrementing any.
  for (const { qty, product } of resolved) {
    if (product && typeof product.stock === 'number' && product.stock < qty) {
      return null;
    }
  }

  for (const { item, qty, product } of resolved) {
    let target = product;
    if (target && target.sellerId === 'ALL') {
      target = { ...target, id: `prod_${crypto.randomBytes(8).toString('hex')}`, sellerId: order.sellerId };
      if (item === resolved[0].item) order.productId = target.id;
      item.productId = target.id;
    }
    if (target && typeof target.stock === 'number') {
      target.stock = Math.max(0, target.stock - qty);
      await store.saveProduct(target);
      if (!primaryProduct) primaryProduct = target;
    }
  }

  order.stockDecremented = true;
  await store.saveOrder(order);
  return primaryProduct;
}

async function settleOrder(store, order, { utr, method, via, actor = 'system', reason = '' }) {
  if (order.status === 'PAID') return true;
  if (await expireOrder(store, order)) return false;

  const resolved = await resolveOrderItemProducts(store, order);
  const insufficient = resolved.some(({ qty, product }) => product && typeof product.stock === 'number' && product.stock < qty);
  if (insufficient) {
    order.isOutOfStock = true;
    order.fulfillmentIssue = 'OUT_OF_STOCK';
    order.paymentStatus = 'REVIEW_REQUIRED';
    await store.saveOrder(order);
    return false;
  }

  normalizeOrderSteps(order);
  const now = new Date().toISOString();
  Object.assign(order, {
    status: 'PAID',
    paymentStatus: 'CONFIRMED',
    utr,
    paymentMethod: method,
    paymentRef: `pay_${crypto.randomBytes(12).toString('hex')}`,
    paidAt: now,
    verifiedVia: via,
    matchReason: reason,
    fulfillmentIssue: null,
    isOutOfStock: false
  });
  order.steps.paymentConfirmed = { done: true, time: now, utr, method };
  order.steps.spreadsheetUpdated = { done: false, time: null };
  order.currentStep = 'PAYMENT_CONFIRMED';
  if (!order.dispatchStatus || order.dispatchStatus === 'PENDING') order.dispatchStatus = 'PACKING';
  addOrderActivity(order, 'PAYMENT_CONFIRMED', actor, { via, reason });
  await store.saveOrder(order);
  await decrementProductStockOnPayment(store, order);
  return true;
}

function buildFunnel(orders) {
  const paid = orders.filter(o => o.status === 'PAID');
  const viewed = orders.filter(o => o.steps && o.steps.opened && o.steps.opened.done).length;
  const addressAdded = orders.filter(o => o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done)).length;
  const paymentStarted = orders.filter(o => o.status === 'PAID' || (o.steps && o.steps.redirectedToPayment && o.steps.redirectedToPayment.done)).length;
  const revenue = paid.reduce((sum, o) => sum + parseFloat(o.payableAmount !== undefined ? o.payableAmount : (o.amount || 0)), 0);
  const abandonedLeads = orders.filter(o => o.status !== 'PAID' && (o.address || (o.steps && o.steps.addressEntered && o.steps.addressEntered.done)));

  return {
    funnel: {
      sent: orders.length,
      viewed,
      addressAdded,
      paymentStarted,
      paid: paid.length,
      revenue,
      conversionRate: orders.length > 0 ? Math.round((paid.length / orders.length) * 100) : 0,
      abandonedAtAddress: abandonedLeads.length
    },
    abandonedLeads,
    paidCount: paid.length,
    revenue
  };
}

module.exports = {
  expireOrder,
  findCheckoutOrder,
  orderLinkResponse,
  resolveOrderLineItems,
  decrementProductStockOnPayment,
  settleOrder,
  buildFunnel
};

