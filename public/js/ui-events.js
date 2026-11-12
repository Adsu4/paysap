// Declarative event delegation for studio workspace UI (strict CSP: zero inline event attributes).
(function () {
  'use strict';

  function runAction(name, el, event) {
    const arg = el.dataset.arg;
    const arg2 = el.dataset.arg2;
    switch (name) {
      case 'switchToStudioCockpit': return window.switchToStudioCockpit?.();
      case 'setMasterTab':
        window.setMasterTab?.(arg);
        if (arg2) window.setSettingsTab?.(arg2);
        return;
      case 'setSettingsTab': return window.setSettingsTab?.(arg);
      case 'handleLogout': return window.handleLogout?.();
      case 'customItem': return window.PaySapExperience?.customItem?.();
      case 'focusCatalogSelect': return document.getElementById('catalogSelect')?.focus();
      case 'adjustAmount': return window.adjustAmount?.(Number(arg));
      case 'addOrderLineItem': return window.addOrderLineItem?.();
      case 'removeOrderLineItem': return window.removeOrderLineItem?.(Number(arg));
      case 'openRestockFromBuilder': return window.openRestockFromBuilder?.();
      case 'copyCurrentLink': return window.copyCurrentLink?.();
      case 'copyPitchText': return window.copyPitchText?.();
      case 'openWhatsAppDirect': return window.openWhatsAppDirect?.();
      case 'shareCurrentOrderMobile': return window.shareCurrentOrderMobile?.();
      case 'createNextSale': return window.createNextSale?.();
      case 'activateActiveOrder': return window.activateActiveOrder?.();
      case 'activateTab': return window.activateTab?.(arg);
      case 'switchActionQueue': return window.switchActionQueue?.(arg);
      case 'markCockpitOrderPaid': return window.markCockpitOrderPaid?.();
      case 'openWhatsAppForCockpit': return window.openWhatsAppForCockpit?.();
      case 'copyCockpitLink': return window.copyCockpitLink?.();
      case 'renderActionQueueContent': return window.renderActionQueueContent?.();
      case 'fetchOrdersAndMetrics': return window.fetchOrdersAndMetrics?.(true);
      case 'openQueue': return window.PaySapExperience?.openQueue?.(arg);
      case 'loadStoreSettings': return window.loadStoreSettings?.(true);
      case 'clickElement': return document.getElementById(arg)?.click();
      case 'clearStoreLogo': return window.clearStoreLogo?.();
      case 'openAddSalesmanModal': return window.openAddSalesmanModal?.();
      case 'saveBankMonitoringSettings': return window.saveBankMonitoringSettings?.();
      case 'openOAuthConfigModal': return window.openOAuthConfigModal?.();
      case 'connectGoogleOAuth': return window.connectGoogleOAuth?.();
      case 'disconnectGoogleOAuth': return window.disconnectGoogleOAuth?.();
      case 'focusCustomSenderInput': return window.focusCustomSenderInput?.();
      case 'copyStoreWebhookUrl': return window.copyStoreWebhookUrl?.();
      case 'handleSaveStoreSettings': return window.handleSaveStoreSettings?.();
      case 'openAddProductModal': return window.openAddProductModal?.();
      case 'fetchProductCatalog': return window.fetchProductCatalog?.(true);
      case 'toggleQrModal': return window.toggleQrModal?.(arg === 'true');
      case 'closeAddSalesmanModal': return window.closeAddSalesmanModal?.();
      case 'closeEditSalesmanModal': return window.closeEditSalesmanModal?.();
      case 'closeAddProductModal': return window.closeAddProductModal?.();
      case 'clearNewProductImage': return window.clearNewProductImage?.();
      case 'closeQuickSaleModal': return window.closeQuickSaleModal?.();
      case 'adjustQsAmount': return window.adjustQsAmount?.(Number(arg));
      case 'copyQsLink': return window.copyQsLink?.();
      case 'shareQsLinkNative': return window.shareQsLinkNative?.();
      case 'closeTestEmailModal': return window.closeTestEmailModal?.();
      case 'loadSampleEmailPreset': return window.loadSampleEmailPreset?.(arg);
      case 'closeOAuthConfigModal': return window.closeOAuthConfigModal?.();
      case 'copyOauthRedirectUri': return window.copyOauthRedirectUri?.();
      case 'handleCatalogSelect': return window.handleCatalogSelect?.(arg !== undefined ? arg : el.value);
      case 'shareOrderLinkMobile':
        return window.shareOrderLinkMobile?.(el.dataset.ref, el.dataset.url, el.dataset.desc, el.dataset.amt);
      case 'handleToggleStaffStockAccess':
        return window.handleToggleStaffStockAccess?.(el.dataset.id, el.dataset.access === 'true');
      case 'openEditSalesmanModal':
        return window.openEditSalesmanModal?.(el.dataset.id, el.dataset.name || '', '', el.dataset.access === 'true');
      case 'handleDeleteSalesman':
        return window.handleDeleteSalesman?.(el.dataset.id, el.dataset.name || '');
      case 'setVerifiedSenderChip':
        return window.setVerifiedSenderChip?.(arg);
      case 'copyToClipboard':
        return window.copyToClipboard?.(arg, null);
      case 'handleAdjustStock':
        return window.handleAdjustStock?.(el.dataset.id, Number(el.dataset.delta));
      case 'handleDeleteProduct':
        return window.handleDeleteProduct?.(el.dataset.id, el.dataset.name || '');
      case 'lookupSku': return window.lookupSku?.(el.value);
      case 'handleOrderSearch': return window.handleOrderSearch?.(el.value);
      case 'handleDispatchSalesmanFilter': return window.handleDispatchSalesmanFilter?.(el.value);
      case 'updateSettingsPreview': return window.updateSettingsPreview?.();
      case 'handleLogoFileSelect': return window.handleLogoFileSelect?.(event);
      case 'handleLogoUrlInput': return window.handleLogoUrlInput?.(el.value);
      case 'onBankSelectChange': return window.onBankSelectChange?.(arg === 'true');
      case 'onSenderInputTyped': return window.onSenderInputTyped?.();
      case 'filterStockTable': return window.filterStockTable?.();
      case 'handleProductImageSelect': return window.handleProductImageSelect?.(event);
      case 'handleProductImageUrl': return window.handleProductImageUrl?.(el.value);
      case 'handleDirectStockInput': return window.handleDirectStockInput?.(el.dataset.id, el.value);
      case 'recomputeOrderLineItems': return window.recomputeOrderLineItems?.();
      case 'updateOrderLineItemField': return window.updateOrderLineItemField?.(Number(el.dataset.idx), el.dataset.field, el.value);
      case 'handleAddSalesmanSubmit': return window.handleAddSalesmanSubmit?.();
      case 'handleEditSalesmanSubmit': return window.handleEditSalesmanSubmit?.();
      case 'handleAddNewProductSubmit': return window.handleAddNewProductSubmit?.();
      case 'handleQuickSaleSubmit': return window.handleQuickSaleSubmit?.();
      case 'submitTestEmailIngestion': return window.submitTestEmailIngestion?.();
      case 'savePlatformOAuthConfig': return window.savePlatformOAuthConfig?.();
      default: break;
    }
  }

  document.addEventListener('click', event => {
    const clickTarget = event.target.closest('[data-click]');
    const stopEl = event.target.closest('a, [data-stop-prop]');
    if (stopEl && clickTarget && stopEl !== clickTarget && clickTarget.contains(stopEl)) {
      return;
    }
    if (clickTarget) {
      runAction(clickTarget.dataset.click, clickTarget, event);
    }
  });

  document.addEventListener('input', event => {
    const el = event.target.closest('[data-input]');
    if (el) runAction(el.dataset.input, el, event);
  });

  document.addEventListener('change', event => {
    const el = event.target.closest('[data-change]');
    if (el) runAction(el.dataset.change, el, event);
  });

  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-submit]');
    if (form) {
      event.preventDefault();
      runAction(form.dataset.submit, form, event);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('logoPreviewContainer');
    if (dropZone) {
      dropZone.addEventListener('dragover', event => {
        event.preventDefault();
        dropZone.classList.add('border-indigo-600', 'bg-indigo-50/50');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('border-indigo-600', 'bg-indigo-50/50');
      });
      dropZone.addEventListener('drop', event => {
        event.preventDefault();
        dropZone.classList.remove('border-indigo-600', 'bg-indigo-50/50');
        window.handleLogoDrop?.(event);
      });
    }
  });
})();
