const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWindow } = require('./local-transparency.cjs');

class Window {
  constructor(options) {
    this.options = options;
    this.background = options.backgroundColor;
    this.webContents = { on() {} };
  }
  setBackgroundColor(color) { this.background = color; }
}

test('main window has native background transparency without changing content opacity', () => {
  const options = { minWidth: 840, minHeight: 620, autoHideMenuBar: true,
    backgroundColor: '#111111', webPreferences: { preload: 'preload.cjs', sandbox: true } };
  const win = createWindow({ BrowserWindow: Window }, options);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.backgroundColor, '#00000000');
  assert.equal(win.options.opacity, undefined);
  assert.equal(win.options.webPreferences.sandbox, true);
  win.setBackgroundColor('#ffffff');
  assert.equal(win.background, '#00000000');
  assert.equal(options.backgroundColor, '#111111');
});

test('other windows retain their original rendering options', () => {
  const options = { width: 400, height: 300, backgroundColor: '#ffffff' };
  const win = createWindow({ BrowserWindow: Window }, options);
  assert.equal(win.options, options);
  win.setBackgroundColor('#112233');
  assert.equal(win.background, '#112233');
});
