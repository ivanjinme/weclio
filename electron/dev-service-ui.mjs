import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid port: ${value}`);
  return number;
}

async function checkPort(number) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`Port ${number} unavailable: ${error.message}`)));
    server.listen({ host: "127.0.0.1", port: number, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// 仅终止本脚本创建的进程树，不能按进程名清理系统 Node。
async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", reject);
      killer.once("exit", resolve);
    });
    return;
  }
  const signal = (name) => {
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  signal("SIGKILL");
}

export async function main({ env = process.env, cwd = root, spawnChild = spawn, timeoutMs = 20_000, desktop, onOutput = () => {} } = {}) {
  const servicePort = port(env.WECLIO_DEV_SERVICE_PORT, 8899);
  const uiPort = desktop ? undefined : port(env.WECLIO_DEV_UI_PORT, 8888);
  const uiUrl = desktop ? "weclio://app" : `http://127.0.0.1:${uiPort}`;
  const assetDir = desktop ? resolve(cwd, env.WECLIO_DESKTOP_UI_DIR ?? "build/desktop-ui") : undefined;
  if (desktop && !existsSync(join(assetDir, "index.html"))) {
    throw new Error(`Desktop UI not found: ${join(assetDir, "index.html")}; run npm run build:desktop-ui before starting Desktop (or set WECLIO_DESKTOP_UI_DIR to a prebuilt asset directory)`);
  }
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (servicePort === uiPort) throw new Error("Service and UI ports must differ");
  // Desktop 不占用 HTTP UI 端口；Web 两个端口都检查完才创建子进程。
  await checkPort(servicePort);
  if (!desktop) await checkPort(uiPort);
  const stateDir = env.WECLIO_AGENT_STATE_DIR ?? join(cwd, "build/dev-service-state");
  const tokenPath = env.WECLIO_AGENT_TOKEN_FILE ?? join(stateDir, "service-token");
  if (!isAbsolute(stateDir) || !isAbsolute(tokenPath)) throw new Error("Service stateDir and token file must be absolute paths");
  // 独立输出目录隔离 NEXT_PUBLIC_* 编译产物，不清理用户的普通 Next UI。
  const distDir = env.WECLIO_DEV_UI_DIST_DIR ?? "build/dev-service-ui";
  const devOutput = resolve(cwd, distDir, "dev");
  if (!desktop && existsSync(join(devOutput, "lock"))) throw new Error(`Next dev output is locked: ${devOutput}; stop the dedicated service UI first`);

  const children = [];
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  // 就绪之前的退出也必须立即被观察，避免未处理的拒绝。
  failed.catch(() => {});
  let interrupted;
  const signal = new Promise((resolve) => { interrupted = resolve; });
  const onSignal = () => interrupted();
  // process.exit() 不等待 finally；仅同步清理本次拥有的进程树。
  const onExit = () => {
    for (const child of children) {
      if (!child.pid) continue;
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
        if (result.error) console.error(`[dev] ${result.error.message}`);
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") console.error(`[dev] ${error.message}`); }
      }
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", onExit);
  let timer;
  function run(name, args, env, output, executable = process.execPath) {
    const child = spawnChild(executable, args, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: name !== "desktop", detached: process.platform !== "win32",
    });
    children.push(child);
    child.once("error", (error) => fail(new Error(`[${name}] ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (name === "desktop" && code === 0) interrupted();
      else fail(new Error(`[${name}] exited (${signal ?? code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const message = `[${name}] ${chunk}`;
      process.stdout.write(message);
      onOutput(message);
      output?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const message = `[${name}] ${chunk}`;
      process.stderr.write(message);
      onOutput(message);
    });
    return child;
  }
  try {
    let ready;
    const readiness = new Promise((resolve, reject) => {
      ready = resolve;
      timer = setTimeout(() => reject(new Error("Timed out waiting for WECLIO_AGENT_READY")), timeoutMs);
    });
    let output = "";
    const jiti = pathToFileURL(require.resolve("jiti")).href;
    run("service", ["--import", jiti, "--eval",
      `const { createJiti } = await import(${JSON.stringify(jiti)});
       const jiti = createJiti(import.meta.url);
       const entry = await jiti.import(${JSON.stringify(pathToFileURL(join(cwd, "lib/agent/service/entry.ts")).href)});
       await entry.main();`,
    ], {
      ...childEnv,
      WECLIO_AGENT_HOST: "127.0.0.1",
      WECLIO_AGENT_PORT: String(servicePort),
      WECLIO_AGENT_ALLOWED_ORIGINS: uiUrl,
      WECLIO_AGENT_STATE_DIR: stateDir,
      ...(env.WECLIO_DEV_AGENT_DIR ? { PI_CODING_AGENT_DIR: env.WECLIO_DEV_AGENT_DIR } : {}),
    }, (chunk) => {
      output += chunk;
      let end;
      while ((end = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        if (!line.startsWith("WECLIO_AGENT_READY ")) continue;
        try {
          const event = JSON.parse(line.slice("WECLIO_AGENT_READY ".length));
          if (event.url !== `http://127.0.0.1:${servicePort}`) throw new Error(`Unexpected service URL: ${event.url}`);
          ready(true);
        } catch (error) { fail(error); }
      }
    });
    const started = await Promise.race([readiness, failed, signal]);
    clearTimeout(timer);
    if (!started) return;
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!token) throw new Error(`Agent token file is empty: ${tokenPath}`);
    if (desktop) {
      // 静态资产已由启动器预检；Service 就绪后直接拉起 GUI，不再启动 Next。
      const desktopEnv = {
        ...childEnv,
        WECLIO_DESKTOP_AGENT_URL: `http://127.0.0.1:${servicePort}`,
        WECLIO_DESKTOP_AGENT_TOKEN_FILE: tokenPath,
        WECLIO_DESKTOP_UI_DIR: assetDir,
      };
      delete desktopEnv.NEXT_PUBLIC_WECLIO_API_URL;
      delete desktopEnv.NEXT_PUBLIC_WECLIO_API_BASE_PATH;
      delete desktopEnv.NEXT_PUBLIC_WECLIO_AGENT_TOKEN;
      run("desktop", desktop.args ?? [], desktopEnv, undefined, desktop.executable);
    } else {
      run("ui", [require.resolve("next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(uiPort)], {
        ...childEnv,
        WECLIO_DEV_UI_DIST_DIR: distDir,
        NEXT_PUBLIC_WECLIO_API_URL: `http://127.0.0.1:${servicePort}`,
        NEXT_PUBLIC_WECLIO_API_BASE_PATH: "/v1",
        NEXT_PUBLIC_WECLIO_AGENT_TOKEN: token,
      });
    }
    await Promise.race([failed, signal]);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try { await Promise.all(children.map(stopTree)); }
    finally { process.removeListener("exit", onExit); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  });
}
