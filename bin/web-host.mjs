import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

function serviceEntry(root) {
  const entry = join(root, "build/web-package/service/entry.mjs");
  if (!existsSync(entry)) throw new Error("Agent Service artifact missing. Reinstall Weclio or run npm run build:web-service from source.");
  return entry;
}

export async function runStandalone(root) {
  const entry = serviceEntry(root);
  delete process.env.WECLIO_AGENT_PARENT_STDIN;
  await import(pathToFileURL(entry).href);
}

async function verifyConnection(baseUrl, tokenFile, origin, version, signal) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error("Expected a loopback Agent Service origin: http://127.0.0.1:<port>");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error("Agent Service credential is empty");
  const res = await fetch(`${baseUrl}/v1/info`, {
    headers: { Authorization: `Bearer ${token}`, Origin: origin }, redirect: "error", signal,
  });
  if (res.status === 403 || (res.ok && res.headers.get("access-control-allow-origin") !== origin)) {
    throw new Error(`Agent Service must allow Web origin ${origin}.`);
  }
  if (!res.ok) throw new Error(`Agent Service readiness rejected: HTTP ${res.status}`);
  const info = await res.json();
  if (info.protocol?.version !== version || !Number.isInteger(info.protocol.minClient) ||
      info.protocol.minClient < 1 || info.protocol.minClient > version) throw new Error("Agent Service protocol mismatch");
  return { connection: { baseUrl, token }, info };
}

async function waitForService(child, stateDir, tokenFile, origin, version, signal) {
  const readyPrefix = "WECLIO_AGENT_READY ";
  const lines = createInterface({ input: child.stdout });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  deadline.addEventListener("abort", close, { once: true });
  try {
    deadline.throwIfAborted();
    for await (const line of lines) {
      if (!line.startsWith(readyPrefix)) { console.log(line); continue; }
      const ready = JSON.parse(line.slice(readyPrefix.length));
      const owner = JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
      if (owner.pid !== child.pid || !ready.instanceId || owner.instanceId !== ready.instanceId) throw new Error("Agent Service identity mismatch");
      const { connection, info } = await verifyConnection(ready.url, tokenFile, origin, version, deadline);
      if (info.instanceId !== ready.instanceId || info.serviceId !== ready.serviceId) throw new Error("Agent Service identity mismatch");
      return connection;
    }
    deadline.throwIfAborted();
    throw new Error("Agent Service exited before readiness");
  } finally {
    deadline.removeEventListener("abort", close);
    lines.close();
  }
  function close() { lines.close(); }
}

function openBrowser(url) {
  const windows = process.platform === "win32";
  const command = windows ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  const opener = spawn(command, [url], { shell: windows, stdio: "ignore", detached: true });
  opener.on("error", (error) => console.warn(`Could not open browser: ${error.message}`));
  opener.unref();
}

export async function runWeb(root, { hostname, port, openBrowser: autoOpen, attach }) {
  if (!["127.0.0.1", "localhost"].includes(hostname)) throw new Error("Managed Web requires loopback (-H 127.0.0.1 or localhost).");
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error(`Invalid Web port: ${port}`);
  if (attach && !isAbsolute(attach.tokenFile)) throw new Error("--token-file must be an absolute path.");
  const { PROTOCOL_VERSION } = await import(pathToFileURL(fileURLToPath(new URL("../lib/agent/protocol/version-value.mjs", import.meta.url))).href);
  process.env.NODE_ENV = "production";
  delete process.env.WECLIO_DEV_UI_DIST_DIR;
  const abort = new AbortController();
  const requestStop = () => abort.abort();
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  // 与独立 Service 相同的可移植停止约定：显式 "shutdown" 行；只有托管方才能用 stdin EOF。
  const control = createInterface({ input: process.stdin, terminal: false });
  control.on("line", (line) => { if (line.trim() === "shutdown") requestStop(); });
  if (process.env.WECLIO_WEB_PARENT_STDIN === "1") control.once("close", requestStop);
  let connection, origin, nextHandler, child, exited;
  const server = createServer((req, res) => {
    // 不信任反代头；连接信息只提供给直接访问的本机同源 UI。
    if (req.socket.remoteAddress !== "127.0.0.1" || !origin || req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end(); return;
    }
    res.setHeader("X-Frame-Options", "DENY");
    if (req.url === "/_weclio/connection") {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method !== "POST" || req.headers.origin !== origin || req.headers["x-weclio-bootstrap"] !== "1") {
        res.writeHead(403).end(); return;
      }
      if (!connection || !nextHandler) { res.writeHead(503).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(connection));
      return;
    }
    if (!nextHandler) { res.writeHead(503).end("Weclio is starting."); return; }
    Promise.resolve().then(() => nextHandler(req, res)).catch((error) => {
      console.error(`[weclio-ui] ${error.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  let timeout;
  try {
    server.listen(Number(port), "127.0.0.1");
    await once(server, "listening");
    origin = `http://${hostname}:${server.address().port}`;
    const failures = [];
    if (attach) {
      ({ connection } = await verifyConnection(attach.serviceUrl, attach.tokenFile, origin, PROTOCOL_VERSION,
        AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])));
    } else {
      const entry = serviceEntry(root);
      const stateDir = resolve(process.env.WECLIO_AGENT_STATE_DIR ?? join(homedir(), ".weclio/agent-service"));
      const tokenFile = resolve(process.env.WECLIO_AGENT_TOKEN_FILE || join(stateDir, "service-token"));
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|WECLIO_AGENT_(HOST|PORT|STATE_DIR|TOKEN_FILE|ALLOWED_ORIGINS|PARENT_STDIN))$/i.test(key)));
      child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: {
        ...childEnv, WECLIO_AGENT_HOST: "127.0.0.1", WECLIO_AGENT_PORT: "0", WECLIO_AGENT_STATE_DIR: stateDir,
        WECLIO_AGENT_ALLOWED_ORIGINS: origin, WECLIO_AGENT_PARENT_STDIN: "1",
        ...(process.env.WECLIO_AGENT_TOKEN_FILE ? { WECLIO_AGENT_TOKEN_FILE: tokenFile } : {}),
      } });
      child.stdin.on("error", () => { /* 退出结果由子进程事件报告。 */ });
      exited = once(child, "exit");
      const failed = exited.then(([code, signal]) => { throw new Error(`Agent Service exited (${signal ?? code})`); });
      failures.push(failed);
      connection = await Promise.race([waitForService(child, stateDir, tokenFile, origin, PROTOCOL_VERSION, abort.signal), failed]);
      // READY 之后继续排空管道，不能因日志积压阻塞 Service。
      child.stdout.resume();
    }
    // Next 的生产路由以 cwd 解析构建清单；保留上面已解析的用户数据路径。
    process.chdir(root);
    const next = createRequire(join(root, "package.json"))("next");
    const app = next({ dir: root, dev: false, hostname, port: server.address().port, httpServer: server });
    await Promise.race([app.prepare(), ...failures]);
    abort.signal.throwIfAborted();
    nextHandler = app.getRequestHandler();
    console.log(`Weclio ready: ${origin}`);
    if (autoOpen) openBrowser(origin);
    await Promise.race([once(abort.signal, "abort"), ...failures]);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    connection = undefined;
    server.close();
    server.closeAllConnections();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.stdin.end("shutdown\n");
      timeout = setTimeout(() => child.kill(), 13_000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    control.close();
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}
