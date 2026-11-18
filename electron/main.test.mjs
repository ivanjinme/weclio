import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      scripts: [], downloads: [],
      downloadURL(url) { this.downloads.push(url); },
      mainFrame: { url: 'weclio://app/index.html' },
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

function runMain(check, { platform = process.platform, setup = "", packaged = false, startupFailure = false } = {}) {
  const mockUrl = `data:text/javascript,${encodeURIComponent(mock)}`;
  const serviceMock = `data:text/javascript,${encodeURIComponent(`export const starts=[]; export let stops=0; export const control={inspect:async()=>'ready',lock:async()=>'ready',unlock:async()=>{}}; export async function startLocalAgentService(options){ starts.push(options); if(${startupFailure}) throw new Error('fixture local service failed'); return {baseUrl:'http://127.0.0.1:1889'+starts.length,token:'owned-token',uiDir:'fixture/ui',control,stop:async()=>{stops++; return 0}}; }`)}`;
  const toolsMock = `data:text/javascript,${encodeURIComponent("export async function resolveDesktopTools(){return 'fixture-tools'}")}`;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { setImmediate } from 'node:timers/promises';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
      if (${packaged} && specifier === './local-service.mjs') return {url:${JSON.stringify(serviceMock)},shortCircuit:true};
      if (${packaged} && specifier === './toolsets.mjs') return {url:${JSON.stringify(toolsMock)},shortCircuit:true};
      return next(specifier, context);
    }});
    const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = await import('electron');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const profile = mkdtempSync(join(tmpdir(), 'weclio-main-test-'));
    process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
    app.getPath = (name) => name === 'userData' ? profile : 'test-logs';
    app.isPackaged = ${packaged};
    process.resourcesPath = 'fixture-resources';
    const local = ${packaged} ? await import(${JSON.stringify(serviceMock)}) : null;
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
    assert.deepEqual(handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }),
      { baseUrl: 'http://127.0.0.1:18890', token: 'desktop-fixture-token' });
    assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }), /Untrusted/);
    assert.throws(() => handler({ sender: window.webContents, senderFrame: { url: 'weclio://app/index.html' } }), /Untrusted/);
    for (const sender of [{ url: 'https://example.com/' }, { url: 'http://127.0.0.1:8888/' }, { url: 'weclio://app/assets/app.js' }, {}, null]) {
      assert.throws(() => handler({ senderFrame: sender }), /Untrusted/);
    }
    assert.equal(JSON.stringify(window.urls).includes('desktop-fixture-token'), false, 'the token must not appear in any URL');
  `);
});

test("Desktop downloads accept only selected-Service tickets from the owning main frame", () => {
  runMain(`
    const handler=ipcMain.handlers.get('resource:download');
    const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
    handler(event,'http://127.0.0.1:18890/v1/resources/content?ticket=opaque-ticket');
    assert.deepEqual(window.webContents.downloads,['http://127.0.0.1:18890/v1/resources/content?ticket=opaque-ticket']);
    for(const url of ['https://evil.example/v1/resources/content?ticket=x','http://127.0.0.1:18891/v1/resources/content?ticket=x','http://127.0.0.1:18890/v1/files/a','http://127.0.0.1:18890/v1/resources/content?ticket=x&write=1','http://127.0.0.1:18890/v1/resources/content?ticket=x#fragment','file:///C:/secret'])assert.throws(()=>handler(event,url),/Invalid desktop resource/);
    assert.throws(()=>handler({...event,senderFrame:{url:'weclio://app/index.html'}},'http://127.0.0.1:18890/v1/resources/content?ticket=x'),/Untrusted/);
    assert.equal(window.urls.length,1,'download must not navigate or replace the application');
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

test("packaged Desktop starts its owned Service before exposing static UI, not a Next server", () => {
  runMain(`
    assert.equal(local.starts.length,1);
    assert.equal(local.starts[0].resourcesPath,'fixture-resources');
    assert.equal(local.starts[0].stateDir,join(profile,'agent-service'));
    assert.equal(local.starts[0].toolsRoot,'fixture-tools');
    assert.equal(local.starts[0].appVersion,'0.1.12');
    assert.match(window.urls[0],/^data:text\\/html/);
    assert.equal(window.urls[1],'weclio://app/index.html');
    const handler=ipcMain.handlers.get('agent-service:config');
    assert.equal(handler({sender:window.webContents,senderFrame:window.webContents.mainFrame}).token,'owned-token');
    app.emit('will-quit', { preventDefault() {} }); await setImmediate();
    app.emit('will-quit', { preventDefault() {} }); await setImmediate();
    assert.equal(local.stops,1);
    assert.equal(local.starts[0].signal.aborted,true);
    assert.equal(ipcMain.handlers.has('agent-service:config'),false);
  `, {packaged:true});
});

test("installer failure recovery restarts the owned Service before the window returns", async () => {
  // 结构约束：恢复窗口前必须重新拉起自有 Service，否则会出现「窗口在、后端没了」。
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const restore = source.slice(source.indexOf("restoreWindow: async () => {"), source.indexOf("const removeUpdateBridge"));
  assert.match(restore, /serviceStopped/);
  assert.match(restore, /await startOwnedAgent\(\)/);
  assert.ok(restore.indexOf("await startOwnedAgent()") < restore.indexOf("createMainWindow"), "Service must be running before the window is recreated");
});

test("ordinary quit leaves Service running until window close has been accepted", () => {
  runMain(`
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit('before-quit', event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(local.stops, 0, 'renderer can still veto close');
    app.emit('will-quit', event);
    assert.equal(event.defaultPrevented, true, 'final quit waits for Service exit');
    assert.equal(local.stops, 1);
    await setImmediate();
    await setImmediate();
    assert.ok(app.quits >= 1, 'quit is re-requested after the Service stopped');
    const second = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit('will-quit', second);
    assert.equal(second.defaultPrevented, false, 'subsequent quit is allowed through');
    assert.equal(local.stops, 1, 'the Service is stopped exactly once');
  `, {packaged:true});
});

test("packaged startup failure stays closed without exposing credentials or falling back", () => {
  runMain(`
    assert.deepEqual(app.exits,[1]);
    assert.equal(window.urls.length,1);
    assert.equal(ipcMain.handlers.has('agent-service:config'),false);
    assert.match(dialog.errors[0][1],/fixture local service failed/);
  `, {packaged:true,startupFailure:true});
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
