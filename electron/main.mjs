import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeUpdates, registerUpdateBridge, UPDATE_CHANNELS } from "./updates.mjs";
import { createUpdateInstaller } from "./update-install.mjs";
import { isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";
import { APP_ENTRY_URL, APP_SCHEME, createAppProtocolHandler, registerAppScheme } from "./protocol.mjs";
import { startLocalAgentService } from "./local-service.mjs";
import { resolveDesktopTools } from "./toolsets.mjs";
import { desktopStartupPage } from "../lib/startup-splash.mjs";

app.setName("Weclio");
// 必须在 ready 之前注册：standard/secure 才有稳定 origin 与 fetch 能力。
registerAppScheme(protocol);

// 主进程错误必须落盘：Windows 上 GUI 进程没有终端可看 stderr，
// 否则「启动失败 / 更新失败」只能靠猜（2026-11-09 就因为这一点无法定位）。
function installMainLog() {
  try {
    const directory = app.getPath("logs");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "main.log");
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(directory, "main.1.log"));
    } catch {}
    const original = console.error.bind(console);
    console.error = (...args) => {
      original(...args);
      const line = args.map((value) => (value instanceof Error ? (value.stack ?? value.message) : String(value))).join(" ");
      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}
`);
      } catch {}
    };
    return true;
  } catch {
    return false;
  }
}
if (!installMainLog()) app.whenReady().then(() => installMainLog());
// 同一 profile 只允许一个实例，避免并发服务争用端口与用户数据。
const holdsSingleInstance = app.requestSingleInstanceLock();
if (!holdsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}
let mainWindow = null;
let localService = null;
let agent = null;
const startup = new AbortController();
let quitting = false;
let updates = null;
const installer = createUpdateInstaller({
  app, dialog, getService: () => updates, getWindow: () => mainWindow,
  // 更新准入必须由自有 Service 的控制管道回答；开发态或 Service 不可用时返回 undefined，安装器拒绝。
  getGate: () => localService?.control,
  stopService: async () => {
    const code = await stopOwnedAgent();
    if (code !== 0) throw new Error("Agent Service 未正常退出，已取消更新。");
  },
  restoreWindow: async () => {
    // 安装失败后 Main 可能已停掉自有 Service；窗口恢复前必须先重新拉起。
    if (app.isPackaged && (!localService || serviceStopped)) {
      serviceStopped = false;
      await startOwnedAgent();
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      const window = createMainWindow();
      await window.loadURL(APP_ENTRY_URL);
    } else if (!isAppUrl(mainWindow.webContents.getURL())) {
      await mainWindow.loadURL(APP_ENTRY_URL);
    }
  },
});
const removeUpdateBridge = registerUpdateBridge({ ipcMain, getWindow: () => mainWindow, isAppUrl, getService: () => updates, dialog, installer });

function showError(message) {
  startup.abort();
  void localService?.stop().catch((error) => console.error("[desktop] Service 停止失败:", error.message));
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox("Weclio 桌面启动失败", message);
  app.exit(1);
}

/**
 * 静态 UI 只通过 HTTP/SSE 连接已选定的独立 Service。
 * 连接信息由宿主进程提供，不能写进静态资产或 URL。
 */
function readAgentService() {
  const baseUrl = process.env.WECLIO_DESKTOP_AGENT_URL;
  const tokenFile = process.env.WECLIO_DESKTOP_AGENT_TOKEN_FILE;
  const uiDir = process.env.WECLIO_DESKTOP_UI_DIR;
  if (!baseUrl || !tokenFile || !uiDir) {
    throw new Error("缺少独立 Agent Service 开发连接配置。请运行 npm run dev:desktop，不要直接运行 Electron 入口。");
  }
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error(`Agent Service 地址无效: ${baseUrl}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Agent Service 地址必须是 HTTP(S) 源: ${baseUrl}`);
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error(`Agent Service 令牌文件为空: ${tokenFile}`);
  return { baseUrl: url.origin, token, uiDir };
}

app.on("window-all-closed", () => { if (!installer.isClosing()) app.quit(); });
let serviceStopped = false;
let quitWaiting = false;
async function stopOwnedAgent() {
  if (!localService) throw new Error("Agent Service 不可用。");
  const code = await localService.stop();
  serviceStopped = true;
  return code;
}
app.on("before-quit", (event) => {
  if (installer.isRecovering()) event.preventDefault();
});
// 等窗口真正关闭，保留 renderer 的草稿否决；更新路径另在交接前停服。
app.on("will-quit", (event) => {
  if (!serviceStopped && localService) {
    event.preventDefault();
    if (quitWaiting) return;
    quitWaiting = true;
    void stopOwnedAgent().then(() => app.quit(), (error) => {
      quitWaiting = false;
      showError(error.message);
    });
    return;
  }
  console.log("[desktop] 正在退出。");
  quitting = true;
  startup.abort();
  ipcMain.removeHandler("agent-service:config");
  ipcMain.removeHandler("resource:download");
  installer.dispose();
  updates?.stop();
  removeUpdateBridge();
});
app.on("child-process-gone", (_event, details) => {
  console.error(`[desktop] ${details.type} 进程退出: ${details.reason} (${details.exitCode})`);
});

function createMainWindow() {
  const window = new BrowserWindow({
    title: "Weclio",
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // 打包后任务栏图标取自 builder.json 内嵌进 exe 的图标；开发态直接用同源 PNG。
    ...(app.isPackaged ? {} : { icon: fileURLToPath(new URL("../public/brand/app-icon-light-512.png", import.meta.url)) }),
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#f8f7ff", symbolColor: "#1d1e21", height: 40 },
    } : {}),
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  // 主窗口的生命周期由主进程持有，不依赖局部回调引用。
  mainWindow = window;
  window.once("closed", () => {
    console.log("[desktop] 窗口已关闭。");
    if (mainWindow === window) mainWindow = null;
  });
  window.once("ready-to-show", () => {
    console.log("[desktop] 首帧就绪，显示窗口。");
    window.show();
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[desktop] 页面加载失败: ${code} ${description} ${url}`);
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`[desktop] 页面错误: ${event.message}`);
  });

  if (process.platform === "win32") {
    // Electron 原生全屏不会更新覆盖层 visible，需要单独同步此只读展示状态。
    const syncFullscreen = () => {
      void window.webContents.executeJavaScript(
        `document.documentElement.toggleAttribute("data-native-fullscreen", ${window.isFullScreen()})`,
      ).catch((error) => console.error("[desktop] 无法同步全屏状态:", error));
    };
    window.on("enter-full-screen", syncFullscreen);
    window.on("leave-full-screen", syncFullscreen);
    window.webContents.on("dom-ready", syncFullscreen);
    window.webContents.on("did-change-theme-color", (_event, color) => {
      if (!color) return;
      // Electron 将 theme-color 规范化为 #rrggbb，按亮度选择原生按钮前景色。
      const rgb = Number.parseInt(color.slice(1), 16);
      const brightness = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
      window.setTitleBarOverlay({ color, symbolColor: brightness < 128 ? "#f0f1f2" : "#1d1e21" });
    });
  }

  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl));
  });
  window.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return isPermissionAllowed(permission, requestingOrigin);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      // 弹出链接交给浏览器，避免完整历史等页面替换主界面；禁止本地协议。
      void shell.openExternal(url).catch((error) => dialog.showErrorBox("无法打开链接", error.message));
    }
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] 页面进程退出: ${details.reason} (${details.exitCode})`);
    if (details.reason === "clean-exit" || window.isDestroyed()) return;
    // 页面崩溃不直接结束服务，保留窗口让用户选择恢复。
    void dialog.showMessageBox(window, {
      type: "error",
      title: "Weclio 页面进程退出",
      message: `页面进程已退出: ${details.reason} (${details.exitCode})`,
      buttons: ["重新加载", "退出"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (window.isDestroyed()) return;
      if (response === 0) window.reload();
      else app.quit();
    }).catch((error) => console.error("[desktop] 无法显示恢复提示:", error));
  });
  return window;
}

/**
 * 自有 Service 的唯一起点：首次启动与更新失败恢复共用。
 * 恢复时必须重新拉起，否则窗口回来了但没有任何可用后端。
 */
async function startOwnedAgent() {
  const toolsRoot = await resolveDesktopTools({ resourcesPath: process.resourcesPath, storeBase: process.env.LOCALAPPDATA, signal: startup.signal });
  const started = await startLocalAgentService({
    resourcesPath: process.resourcesPath, stateDir: join(app.getPath("userData"), "agent-service"),
    logsPath: app.getPath("logs"), appVersion: app.getVersion(), toolsRoot,
    signal: startup.signal, onUnexpectedExit: (error) => { if (!quitting) showError(error.message); },
  });
  agent = started;
  localService = started;
  serviceStopped = false;
  return started;
}

if (holdsSingleInstance) app.whenReady().then(async () => {
  const window = createMainWindow();
  if (app.isPackaged) {
    // 先显示可关闭的启动页；准备内置资源不能让首次启动看起来毫无响应。
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(desktopStartupPage())}`);
    await startOwnedAgent();
  } else agent = readAgentService();
  const current = () => {
    if (!agent) throw new Error("Agent Service 不可用");
    return agent;
  };
  // 静态资产只从构建目录读取；协议不代理任何 Agent API，重启后自动指向新实例。
  protocol.handle(APP_SCHEME, (request) => createAppProtocolHandler(current().uiDir, { serviceUrl: current().baseUrl })(request));
  const assertAppSender = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame?.url ?? "")) throw new Error("Untrusted desktop sender");
  };
  ipcMain.handle("agent-service:config", (event) => {
    assertAppSender(event);
    const service = current();
    return { baseUrl: service.baseUrl, token: service.token };
  });
  ipcMain.handle("resource:download", (event, resourceUrl) => {
    assertAppSender(event);
    if (typeof resourceUrl !== "string" || resourceUrl.length > 20_000) throw new Error("Invalid desktop resource URL");
    const url = new URL(resourceUrl);
    if (url.origin !== current().baseUrl || url.username || url.password || url.pathname !== "/v1/resources/content" || url.hash || url.searchParams.size !== 1 || !url.searchParams.get("ticket")) throw new Error("Invalid desktop resource URL");
    // 不放宽主窗口导航，也不接收路径或请求头；文件授权仍由 Service 兑换票据时检查。
    mainWindow.webContents.downloadURL(url.href);
  });
  if (quitting) return;
  // 更新安装会关闭窗口并退出 Main；期间自有 Service 必须先有序退出，避免安装器替换文件时仍有写入者。
  try { await window.loadURL(APP_ENTRY_URL); }
  catch (error) {
    if (!installer.isClosing()) throw error;
    return;
  }
  // 页面就绪后再启动后台检查，不阻塞首屏；缺少配置时保持静默。
  void initializeUpdates({ app, publish: (state) => {
    if (mainWindow && !mainWindow.isDestroyed() && isAppUrl(mainWindow.webContents.getURL())) mainWindow.webContents.send(UPDATE_CHANNELS.state, state);
  } }).then((service) => {
    if (quitting) service?.stop();
    else { updates = service; updates?.start(); }
  }).catch((error) => console.error("[desktop-update]", error.message));
}).catch((error) => {
  if (!quitting) showError(error.message);
});
