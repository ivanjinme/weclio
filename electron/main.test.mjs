import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const mainUrl = new URL("./main.mjs", import.meta.url).href;
const mock = `
import { EventEmitter } from 'node:events';
export const app = Object.assign(new EventEmitter(), {
  exits: [], quits: 0,
  setName() {}, whenReady: async () => {}, getPath: () => 'test-logs', getVersion: () => '0.1.12',
  requestSingleInstanceLock() { return globalThis.__singleInstance !== false; },
  exit(code) { this.exits.push(code); },
  quit() { this.quits++; }
});
export const dialog = {
  errors: [], prompts: [],
  showErrorBox(...args) { this.errors.push(args); },
  async showMessageBox(...args) { this.prompts.push(args); return { response: 0 }; }
};
export const ipcMain = {
  handlers: new Map(),
  handle(name, fn) { this.handlers.set(name, fn); },
  removeHandler(name) { this.handlers.delete(name); }
};
export const protocol = {
  schemes: [], handlers: new Map(),
  registerSchemesAsPrivileged(value) { this.schemes.push(value); },
  handle(scheme, handler) { this.handlers.set(scheme, handler); }
};
export const shell = {
  opened: [],
  async openExternal(url) { this.opened.push(url); }
};
export class BrowserWindow extends EventEmitter {
  static windows = [];
  constructor(options) {
    super(); this.options = options; this.shown = 0; this.reloads = 0; this.urls = []; this.overlayUpdates = []; this.fullscreen = false;
    this.webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      scripts: [],
      async executeJavaScript(script) { this.scripts.push(script); },
      setWindowOpenHandler(handler) { this.openWindow = handler; }
    });
    BrowserWindow.windows.push(this);
  }
  async loadURL(url) { this.urls.push(url); }
  show() { this.shown++; }
  setTitleBarOverlay(options) { this.overlayUpdates.push(options); }
  reload() { this.reloads++; }
  isDestroyed() { return false; }
  isFullScreen() { return this.fullscreen; }
}
`;

function runMain(check, { platform = process.platform, setup = "" } = {}) {
  const mockUrl = `data:text/javascript,${encodeURIComponent(mock)}`;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { setImmediate } from 'node:timers/promises';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
      return next(specifier, context);
    }});
    const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = await import('electron');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const profile = mkdtempSync(join(tmpdir(), 'weclio-main-test-'));
    process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
    app.getPath = (name) => name === 'userData' ? profile : 'test-logs';
    app.isPackaged = false;
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    // 默认提供一份有效的宿主连接配置；各用例可覆盖或用 setup 删除。
    const tokenFile = join(profile, 'service-token');
    writeFileSync(tokenFile, 'desktop-fixture-token\\n');
    process.env.WECLIO_DESKTOP_AGENT_URL = 'http://127.0.0.1:18890';
    process.env.WECLIO_DESKTOP_AGENT_TOKEN_FILE = tokenFile;
    process.env.WECLIO_DESKTOP_UI_DIR = join(profile, 'desktop-ui');
    ${setup}
    await import(${JSON.stringify(mainUrl)});
    await setImmediate();
    const window = BrowserWindow.windows[0];
    ${check}
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }));
}

test("desktop waits for its first paint before showing the window", () => {
  runMain(`
    assert.equal(window.shown, 0);
    window.emit('ready-to-show');
    assert.equal(window.shown, 1);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
  `);
});

test("Windows overlays native window controls with a sandboxed preload and no renderer Node integration", () => {
  runMain(`
    assert.equal(window.options.titleBarStyle, 'hidden');
    assert.deepEqual(window.options.titleBarOverlay, { color: '#f8f7ff', symbolColor: '#1d1e21', height: 40 });
    assert.match(window.options.webPreferences.preload, /preload\\.cjs$/);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
  `, { platform: "win32" });
});

test("non-Windows platforms retain their native title bar", () => {
  for (const platform of ["darwin", "linux"]) {
    runMain(`
      assert.equal(window.options.titleBarStyle, undefined);
      assert.equal(window.options.titleBarOverlay, undefined);
      assert.equal(window.webContents.listenerCount('did-change-theme-color'), 0);
    `, { platform });
  }
});

test("native fullscreen state is synchronized on transitions and page reload", () => {
  runMain(`
    window.webContents.emit('dom-ready');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, false/);
    window.fullscreen = true;
    window.emit('enter-full-screen');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, true/);
    window.webContents.emit('dom-ready');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, true/);
    window.fullscreen = false;
    window.emit('leave-full-screen');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, false/);
  `, { platform: "win32" });
});

test("theme-color metadata updates native button colors with readable contrast", () => {
  runMain(`
    window.webContents.emit('did-change-theme-color', {}, '#2e2e2e');
    assert.deepEqual(window.overlayUpdates.at(-1), { color: '#2e2e2e', symbolColor: '#f0f1f2' });
    window.webContents.emit('did-change-theme-color', {}, '#f8f7ff');
    assert.deepEqual(window.overlayUpdates.at(-1), { color: '#f8f7ff', symbolColor: '#1d1e21' });
    window.webContents.emit('did-change-theme-color', {}, null);
    assert.equal(window.overlayUpdates.length, 2);
  `, { platform: "win32" });
});

test("the window loads the static application entry and never an HTTP server", () => {
  runMain(`
    assert.deepEqual(window.urls, ['weclio://app/index.html']);
    assert.equal(protocol.schemes.length, 1);
    assert.equal(protocol.schemes[0][0].scheme, 'weclio');
    assert.deepEqual([...protocol.handlers.keys()], ['weclio']);
    for (const url of window.urls) {
      assert.doesNotMatch(url, /^http:/, 'Desktop must not depend on a UI server process');
    }
  `);
});

test("the renderer receives the selected Service through a trusted IPC bridge only", () => {
  runMain(`
    const handler = ipcMain.handlers.get('agent-service:config');
    assert.ok(handler, 'the static UI needs a Service connection');
    assert.deepEqual(handler({ senderFrame: { url: 'weclio://app/index.html' } }),
      { baseUrl: 'http://127.0.0.1:18890', token: 'desktop-fixture-token' });
    for (const sender of [{ url: 'https://example.com/' }, { url: 'http://127.0.0.1:8888/' }, { url: 'weclio://app/assets/app.js' }, {}, null]) {
      assert.throws(() => handler({ senderFrame: sender }), /Untrusted/);
    }
    assert.equal(JSON.stringify(window.urls).includes('desktop-fixture-token'), false, 'the token must not appear in any URL');
  `);
});

test("external HTTP links open in the browser while unsafe popup schemes stay blocked", () => {
  runMain(`
    const url = 'https://example.com/docs';
    assert.deepEqual(window.webContents.openWindow({ url }), { action: 'deny' });
    for (const blocked of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,test', 'vscode://file/test', 'weclio://app/assets/app.js']) {
      assert.deepEqual(window.webContents.openWindow({ url: blocked }), { action: 'deny' });
    }
    await setImmediate();
    assert.deepEqual(shell.opened, [url]);
    assert.deepEqual(window.urls, ['weclio://app/index.html']);
  `);
});

test("a missing Service connection fails closed instead of starting a fallback backend", () => {
  runMain(`
    assert.deepEqual(app.exits, [1]);
    assert.deepEqual(window.urls, [], 'the window must not load anything without a Service');
    assert.match(dialog.errors[0][1], /Agent Service/);
    assert.match(dialog.errors[0][1], /dev:desktop/);
  `, { setup: "delete process.env.WECLIO_DESKTOP_AGENT_URL;" });
});

test("a managed static UI directory is required", () => {
  runMain(`
    assert.deepEqual(app.exits, [1]);
    assert.deepEqual(window.urls, []);
    assert.match(dialog.errors[0][1], /WECLIO_DESKTOP_UI_DIR|Agent Service/);
  `, { setup: "delete process.env.WECLIO_DESKTOP_UI_DIR;" });
});

for (const address of ["not a url", "https://user:pass@127.0.0.1:18890", "http://127.0.0.1:18890/path", "http://127.0.0.1:18890?query=1", "file:///C:/secret"]) {
  test(`an invalid Service address fails closed: ${address}`, () => {
    runMain(`
      assert.deepEqual(app.exits, [1]);
      assert.deepEqual(window.urls, []);
      assert.match(dialog.errors[0][1], /Agent Service/);
    `, { setup: `process.env.WECLIO_DESKTOP_AGENT_URL = ${JSON.stringify(address)};` });
  });
}

test("an empty Service token file fails closed", () => {
  runMain(`
    assert.deepEqual(app.exits, [1]);
    assert.deepEqual(window.urls, []);
    assert.match(dialog.errors[0][1], /令牌文件为空/);
  `, { setup: `writeFileSync(process.env.WECLIO_DESKTOP_AGENT_TOKEN_FILE, '  \\n');` });
});

test("a clean renderer exit does not terminate the desktop", () => {
  runMain(`
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await setImmediate();
    assert.deepEqual(app.exits, []);
    assert.equal(app.quits, 0);
    assert.equal(dialog.errors.length, 0);
    assert.equal(dialog.prompts.length, 0);
  `);
});

test("a renderer crash offers reload instead of immediately terminating the desktop", () => {
  runMain(`
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await setImmediate();
    assert.deepEqual(app.exits, []);
    assert.equal(app.quits, 0);
    assert.equal(dialog.prompts.length, 1);
    assert.equal(window.reloads, 1);
  `);
});
