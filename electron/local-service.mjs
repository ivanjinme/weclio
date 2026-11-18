import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSystemNode } from "./system-node.mjs";
import { PROTOCOL_VERSION } from "../lib/agent/protocol/version-value.mjs";
import { createServiceControl } from "./service-control.mjs";

/** 安装版用系统 Node 启动自有 Service，不回退到其他运行时或接管陌生进程。 */
export async function startLocalAgentService({ resourcesPath, stateDir, logsPath, appVersion, toolsRoot, signal, onUnexpectedExit = () => {}, env = process.env }) {
  const serviceRoot = join(resourcesPath, "service");
  const entry = join(serviceRoot, "entry.mjs");
  const uiDir = join(resourcesPath, "ui");
  if (!existsSync(entry) || !existsSync(join(uiDir, "index.html"))) throw new Error("安装包缺少 Agent Service 或静态 UI，请重新安装 Weclio。");
  signal?.throwIfAborted();
  const runtime = await resolveSystemNode({ env, toolsRoot, signal });
  signal?.throwIfAborted();
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logsPath, { recursive: true });
  const logFile = join(logsPath, "agent-service.log");
  const childEnv = runtime.env;
  Object.assign(childEnv, {
    WECLIO_AGENT_HOST: "127.0.0.1", WECLIO_AGENT_PORT: "0", WECLIO_AGENT_STATE_DIR: stateDir,
    WECLIO_AGENT_VERSION: appVersion,
    WECLIO_AGENT_ALLOWED_ORIGINS: [...new Set(["weclio://app", "http://127.0.0.1:8888", ...(env.WECLIO_AGENT_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)])].join(","),
    WECLIO_AGENT_PARENT_STDIN: "1",
  });
  // 明确使用本次实例的 token 文件；不能继承开发环境对其他 Service 的选择。
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === "WECLIO_AGENT_TOKEN_FILE") delete childEnv[key];
  const child = spawn(runtime.executable, [entry], { cwd: serviceRoot, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let stopping = false;
  let stopped;
  let ready = false;
  let stdout = "";
  let token;
  let lineBuffer = "";
  const control = createServiceControl({ write: (line) => child.stdin.write(line) });
  const record = (chunk) => {
    const text = String(chunk);
    try { appendFileSync(logFile, token ? text.replaceAll(token, "[redacted]") : text); }
    catch (error) { console.error(`[desktop] Service 日志写入失败: ${error.message}`); }
  };
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(1));
  });
  void exited.then(() => control.disconnect());
  const forceStop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      const result = spawnSync(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
      if (result.error || result.status !== 0) record(`[desktop] owned Service cleanup failed: ${result.error?.message ?? result.stderr}\n`);
    } else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  function stop() {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return exited;
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write("shutdown\n");
      let timer;
      try { await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 13_000); })]); }
      finally { clearTimeout(timer); }
      forceStop();
      try {
        return await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("无法确认 Agent Service 已退出。")), 3000);
        })]);
      } finally { clearTimeout(timer); }
    })();
    return stopped;
  }
  const abort = () => { void stop().catch((error) => record(`[desktop] ${error.message}\n`)); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.on("error", (error) => { if (!stopping) record(`[desktop] Service stdin failed: ${error.message}\n`); });
  child.stderr.on("data", record);
  try {
    const identity = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Agent Service 启动超时。日志: ${logFile}`)), 60_000);
      const finish = (error, value) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const cancelled = () => finish(new DOMException("Service startup aborted", "AbortError"));
      signal?.addEventListener("abort", cancelled, { once: true });
      child.once("exit", (code) => {
        signal?.removeEventListener("abort", cancelled);
        if (!stopping) {
          const error = new Error(`Agent Service 已退出 (${code})。日志: ${logFile}`);
          if (ready) onUnexpectedExit(error);
          else finish(error);
        } else if (!ready) finish(new Error("Agent Service startup cancelled"));
      });
      child.once("error", (error) => finish(error));
      child.stdout.on("data", (chunk) => {
        record(chunk);
        lineBuffer += chunk.toString();
        let newline;
        while ((newline = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, newline).trim();
          lineBuffer = lineBuffer.slice(newline + 1);
          // 维护回复走同一 stdout；未就绪前不再交给 READY 解析器。
          if (control.onLine(line)) continue;
          stdout += `${line}\n`;
        }
        let end;
        while ((end = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, end).trim();
          stdout = stdout.slice(end + 1);
          if (!line.startsWith("WECLIO_AGENT_READY ")) continue;
          try {
            const value = JSON.parse(line.slice("WECLIO_AGENT_READY ".length));
            if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) || !value.instanceId || !value.serviceId) throw new Error("Invalid owned Service readiness");
            finish(null, value);
          } catch (error) { finish(error); }
        }
      });
    });
    signal?.throwIfAborted();
    token = readFileSync(join(stateDir, "service-token"), "utf8").trim();
    if (!token) throw new Error("Agent Service 令牌为空");
    const controller = AbortSignal.timeout(10_000);
    const response = await fetch(`${identity.url}/v1/info`, { headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, controller]) : controller });
    if (!response.ok) throw new Error(`Agent Service authentication failed: HTTP ${response.status}`);
    const info = await response.json();
    const owner = JSON.parse(readFileSync(join(stateDir, "service.json"), "utf8"));
    if (info.instanceId !== identity.instanceId || info.serviceId !== identity.serviceId || owner.pid !== child.pid || owner.instanceId !== identity.instanceId || info.protocol?.version !== PROTOCOL_VERSION || !Number.isInteger(info.protocol.minClient) || info.protocol.minClient < 1 || info.protocol.minClient > PROTOCOL_VERSION) throw new Error("Agent Service 身份或协议不匹配，拒绝连接。");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Agent Service exited during startup verification");
    ready = true;
    return { baseUrl: identity.url, token, uiDir, pid: child.pid, stop, logFile, control };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    // 正常启动后仍保留 abort，直到子进程退出；启动失败则已经完成停止。
    void exited.then(() => signal?.removeEventListener("abort", abort));
  }
}
