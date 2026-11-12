/* Curated brand palettes shared by the browser and server. Status colors are independent. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaySapTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const presets = Object.freeze([
    { id: 'lavender', label: 'Lavender', primary: '#4f46e5', primaryHover: '#4338ca', soft: '#f0edff', canvas: '#ebe9f7', surface: '#ffffff', border: '#dcd6f1', ink: '#252136', muted: '#635e77', primaryRgb: '79, 70, 229' },
    { id: 'ocean', label: 'Ocean blue', primary: '#176497', primaryHover: '#0e507c', soft: '#eaf5fc', canvas: '#e9f1f7', surface: '#ffffff', border: '#ccdeeb', ink: '#1c2f3d', muted: '#536c7c', primaryRgb: '23, 100, 151' },
    { id: 'forest', label: 'Forest', primary: '#236847', primaryHover: '#185036', soft: '#ebf6ee', canvas: '#eaf1eb', surface: '#ffffff', border: '#cce0d1', ink: '#20382b', muted: '#586f60', primaryRgb: '35, 104, 71' },
    { id: 'rose', label: 'Rose', primary: '#9e3c66', primaryHover: '#812a50', soft: '#fcf0f5', canvas: '#f6eaf0', surface: '#ffffff', border: '#ead1dc', ink: '#3c2531', muted: '#7b5d6b', primaryRgb: '158, 60, 102' },
    { id: 'sand', label: 'Warm sand', primary: '#805618', primaryHover: '#68420e', soft: '#fcf5e7', canvas: '#f5efe4', surface: '#ffffff', border: '#e7d9bf', ink: '#3a3020', muted: '#796b54', primaryRgb: '128, 86, 24' },
    { id: 'slate', label: 'Slate', primary: '#475569', primaryHover: '#334155', soft: '#f1f4f8', canvas: '#edf0f4', surface: '#ffffff', border: '#d8dee7', ink: '#243041', muted: '#5e6d81', primaryRgb: '71, 85, 105' }
  ].map(Object.freeze));

  function resolve(value) {
    const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return presets.find(preset => preset.id === clean || preset.primary === clean) || presets[0];
  }

  function isValidId(value) {
    return typeof value === 'string' && presets.some(preset => preset.id === value);
  }

  function apply(value) {
    const preset = resolve(value);
    if (typeof document === 'undefined') return preset;
    const element = document.documentElement;
    element.dataset.paysapTheme = preset.id;
    const variables = {
      'theme-primary': preset.primary, 'theme-primary-hover': preset.primaryHover,
      'theme-soft': preset.soft, 'theme-canvas': preset.canvas, 'theme-surface': preset.surface,
      'theme-border': preset.border, 'theme-ink': preset.ink, 'theme-muted': preset.muted,
      'theme-primary-rgb': preset.primaryRgb,
      accent: preset.primary, 'accent-hover': preset.primaryHover, 'accent-soft': preset.soft,
      canvas: preset.canvas, ink: preset.ink, line: preset.border, muted: preset.muted
    };
    for (const [name, color] of Object.entries(variables)) element.style.setProperty('--' + name, color);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = preset.primary;
    return preset;
  }

  return Object.freeze({ presets, resolve, isValidId, apply });
});
