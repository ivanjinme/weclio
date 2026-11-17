import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { main as supervise } from "./dev-service-ui.mjs";
import { createRuntimeEnvironment } from "./runtime.mjs";

const logFile = fileURLToPath(new URL("../node_modules/.cache/weclio-desktop.log", import.meta.url));

export async function main({ env = process.env, args = process.argv.slice(2) } = {}) {
  const { default: electron } = await import("electron");
  mkdirSync(new URL("../node_modules/.cache/", import.meta.url), { recursive: true });
  writeFileSync(logFile, `[desktop] ${new Date().toISOString()} 启动\n`);
  console.log(`[desktop] 日志: ${logFile}`);
  function record(chunk) {
    try { appendFileSync(logFile, chunk); }
    catch (error) { console.error(`[desktop] 无法保存日志: ${error.message}`); }
  }
  try {
    await supervise({
      env: createRuntimeEnvironment(fileURLToPath(new URL("../resources/runtime/win-x64/", import.meta.url)), env),
      desktop: { executable: electron, args: [fileURLToPath(new URL("./main.mjs", import.meta.url)), ...args] },
      onOutput: record,
    });
    record("[desktop] 停止启动器 (0)\n");
  } catch (error) {
    record(`[desktop] ${error.stack ?? error.message}\n`);
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[desktop] ${error.message}`);
    process.exitCode = 1;
  });
}
