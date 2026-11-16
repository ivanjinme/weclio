import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

// P1 开发脚本：同时起「独立 Agent Service」与指向它的 Next UI。
// 用途仅是本地验证「客户端 ↔ Service」这条链路；不属于产品运行时。
// 用法: node scripts/dev-service-ui.mjs
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const jiti = require.resolve("jiti");
const nextBin = require.resolve("next/dist/bin/next");

const SERVICE_PORT = Number(process.env.WECLIO_DEV_SERVICE_PORT ?? 8899);
const UI_PORT = Number(process.env.WECLIO_DEV_UI_PORT ?? 8888);

const children = [];
function run(name, command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.once("exit", (code) => {
    if (code !== 0) console.error(`[${name}] 退出码 ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Service 用系统 Node 跑 TS 源码（B2 之前不打包 Runtime）。
const service = run("service", process.execPath, [
  "--import", pathToFileURL(jiti).href, "--eval",
  `const { createJiti } = await import(${JSON.stringify(pathToFileURL(jiti).href)});
   const jiti = createJiti(import.meta.url);
   const entry = await jiti.import(${JSON.stringify(pathToFileURL(join(root, "lib/agent/service/entry.ts")).href)});
   await entry.main();`,
], {
  ...process.env,
  WECLIO_AGENT_PORT: String(SERVICE_PORT),
  WECLIO_AGENT_ALLOWED_ORIGINS: `http://127.0.0.1:${UI_PORT}`,
  WECLIO_AGENT_STATE_DIR: join(root, "build/dev-service-state"),
  WECLIO_AGENT_WORKSPACE: join(root, "build/dev-service-workspace"),
});

service.once("exit", () => {
  console.error("[service] 提前退出，UI 端将无法连接。");
  shutdown();
});

// UI 指向 Service：NEXT_PUBLIC_* 在构建期注入，故用 dev 时的 env 直接传给 next。
run("ui", process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(UI_PORT)], {
  ...process.env,
  NEXT_PUBLIC_WECLIO_API_URL: `http://127.0.0.1:${SERVICE_PORT}`,
  NEXT_PUBLIC_WECLIO_API_BASE_PATH: "/v1",
});
