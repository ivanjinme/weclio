import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import nodeVersion from "../bin/node-version.js";
import { createServiceRuntimeEnvironment } from "./runtime.mjs";

const run = promisify(execFile);
const probe = "process.stdout.write(JSON.stringify({ version: process.versions.node, standard: process.release.name === 'node' && !process.versions.electron }))";
const requirement = `请安装 Node.js ${nodeVersion.MIN_NODE_VERSION}+，重新启动 Weclio，或将 WECLIO_NODE_EXECUTABLE 设为 node 的绝对路径。`;

export async function resolveSystemNode({ env = process.env, toolsRoot, signal } = {}) {
  const explicit = env.WECLIO_NODE_EXECUTABLE;
  const name = process.platform === "win32" ? "node.exe" : "node";
  const path = Object.entries(env).filter(([key]) => process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH");
  const candidates = explicit ? [explicit] : path.flatMap(([, value]) => value.split(delimiter)
    .map((value) => value.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isAbsolute).map((directory) => join(directory, name)));
  if (explicit && !isAbsolute(explicit)) throw new Error("WECLIO_NODE_EXECUTABLE 必须是 node 的绝对路径。");
  for (const executable of candidates) {
    signal?.throwIfAborted();
    try {
      if (!(await stat(executable)).isFile()) continue;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) continue;
      throw error;
    }
    const childEnv = createServiceRuntimeEnvironment(dirname(executable), toolsRoot, env);
    let identity;
    try {
      const { stdout } = await run(executable, ["-e", probe], { env: childEnv, windowsHide: true, timeout: 5000, signal });
      identity = JSON.parse(stdout);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`无法执行系统 Node.js：${executable}。${requirement}`, { cause: error });
    }
    if (!identity?.standard || !nodeVersion.isNodeVersionSupported(identity.version)) {
      throw new Error(`不支持的 Node.js：${executable}（${identity?.version ?? "未知版本"}）。${requirement}`);
    }
    return { executable, env: childEnv, version: identity.version };
  }
  throw new Error(`找不到系统 Node.js。${requirement}`);
}
