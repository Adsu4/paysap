const express = require('express');
const { sanitizeInput, amountInPaise, hasStockAccess } = require('../utils/security');

function createProductRoutes({ store, auth }) {
  const router = express.Router();

  router.get('/api/products', auth.optionalAuth, async (req, res, next) => {
    try {
      const sellerId = req.seller ? req.seller.id : null;
      const products = await store.listProducts({ sellerId, search: req.query.search || '' });
      res.json({ success: true, products });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/products/:identifier', auth.optionalAuth, async (req, res, next) => {
    try {
      const sellerId = req.seller ? req.seller.id : null;
      const product = await store.findProductByIdentifier(req.params.identifier, sellerId);
      if (!product) return res.status(404).json({ error: 'Product not found in database.' });
      res.json({ success: true, product });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/products', auth.requireAuth, async (req, res, next) => {
    try {
      if (!hasStockAccess(req.seller)) {
        return res.status(403).json({ error: 'Access denied. Stock CRM management permission required. Contact store owner.' });
      }
      const { name, sku, price, stock = 1, description, notes = '', category, image, imageUrl } = req.body;
      const paise = amountInPaise(price);
      if (typeof name !== 'string' || !name.trim() || paise === null ||
          !Number.isSafeInteger(Number(stock)) || Number(stock) < 0) {
        return res.status(400).json({ error: 'Product name, a positive price with at most 2 decimals, and whole stock count are required.' });
      }
      const generatedSku = (sku || name.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase()).slice(0, 16);
      const finalImage = (image || imageUrl || '').trim() || null;
      const newProduct = {
        id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        sku: generatedSku,
        sellerId: req.seller.id,
        name: sanitizeInput(name.trim()),
        category: sanitizeInput(category || req.seller.brandCategory || 'General Products'),
        price: paise / 100,
        stock: Math.max(0, parseInt(stock, 10) || 0),
        description: sanitizeInput((description || name).trim()),
        notes: sanitizeInput(notes.trim()),
        image: finalImage,
        createdAt: new Date().toISOString()
      };
      await store.createProduct(newProduct);
      res.status(201).json({ success: true, product: newProduct });
    } catch (err) {
      next(err);
    }
  });

  router.put('/api/products/:id/stock', auth.requireAuth, async (req, res, next) => {
    try {
      if (!hasStockAccess(req.seller)) {
        return res.status(403).json({ error: 'Access denied. Stock CRM editing permission required. Please contact store owner.' });
      }
      const { stock, delta } = req.body;
      if ((typeof stock !== 'number' || !Number.isSafeInteger(stock)) &&
          (typeof delta !== 'number' || !Number.isSafeInteger(delta))) {
        return res.status(400).json({ error: 'Please provide either stock count or delta value.' });
      }

      const result = await store.withTransaction(async tx => {
        let targetProduct = await tx.findProductByIdentifier(req.params.id, req.seller.id);
        if (!targetProduct) return null;
        if (targetProduct.sellerId === 'ALL') {
          targetProduct = {
            ...targetProduct,
            id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            sellerId: req.seller.id,
            stock: targetProduct.stock || 0,
            createdAt: new Date().toISOString()
          };
        }
        if (typeof stock === 'number' && Number.isSafeInteger(stock)) {
          targetProduct.stock = Math.max(0, Math.floor(stock));
        } else {
          const current = typeof targetProduct.stock === 'number' ? targetProduct.stock : 0;
          targetProduct.stock = Math.max(0, current + Math.floor(delta));
        }
        await tx.saveProduct(targetProduct);
        return targetProduct;
      });

      if (!result) return res.status(404).json({ error: 'Product not found or belongs to another store.' });
      res.json({ success: true, product: result });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/products/:id', auth.requireAuth, async (req, res, next) => {
    try {
      if (!hasStockAccess(req.seller)) {
        return res.status(403).json({ error: 'Access denied. Stock CRM management permission required.' });
      }
      const removed = await store.deleteProduct(req.params.id, req.seller.id);
      if (!removed) return res.status(404).json({ error: 'Product not found or belongs to another store.' });
      res.json({ success: true, message: `Product "${removed.name}" deleted from catalog.` });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createProductRoutes };

