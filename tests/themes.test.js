const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const themes = require('../public/js/themes');

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(a, b) {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('curated palettes retain readable text and action contrast', () => {
  assert.equal(themes.presets.length, 6);
  assert.equal(new Set(themes.presets.map(theme => theme.id)).size, 6);
  for (const theme of themes.presets) {
    assert.ok(contrast('#ffffff', theme.primary) >= 4.5, theme.id + ': button text');
    assert.ok(contrast(theme.primary, theme.soft) >= 4.5, theme.id + ': soft brand text');
    assert.ok(contrast(theme.ink, theme.canvas) >= 7, theme.id + ': body text');
    assert.ok(contrast(theme.muted, theme.canvas) >= 4.5, theme.id + ': secondary text');
  }
});

test('legacy brand colors resolve to curated presets and arbitrary colors fall back', () => {
  assert.equal(themes.resolve('#4f46e5').id, 'lavender');
  assert.equal(themes.resolve('#176497').id, 'ocean');
  assert.equal(themes.resolve('not-a-palette').id, 'lavender');
  assert.equal(themes.resolve('url(javascript:bad)').id, 'lavender');
  assert.equal(themes.isValidId('forest'), true);
  assert.equal(themes.isValidId('#176497'), false);
});

test('browser application sets only curated CSS values and browser chrome', () => {
  const styles = new Map(), meta = {};
  const context = { document: { documentElement: { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } },
    querySelector: () => meta } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/themes.js'), 'utf8'), context);
  context.PaySapTheme.apply('rose');
  assert.equal(context.document.documentElement.dataset.paysapTheme, 'rose');
  assert.equal(styles.get('--theme-primary'), '#9e3c66');
  assert.equal(styles.get('--accent'), '#9e3c66');
  assert.equal(styles.get('--canvas'), '#f6eaf0');
  assert.equal(meta.content, '#9e3c66');
  assert.equal(styles.has('--status-paid'), false);
});
