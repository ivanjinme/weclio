import { win32 } from "node:path";

export function createRuntimeEnvironment(runtimeRoot, env = process.env, platform = process.platform) {
  const result = { ...env };
  if (platform !== "win32") return result;

  const entries = [];
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() !== "path") continue;
    entries.push(...result[key].split(";"));
    delete result[key];
  }
  // 保留原有查找顺序，包内工具只兜底；Windows 环境中只保留一个 PATH 键。
  entries.push(win32.join(runtimeRoot, "tools"));
  const seen = new Set();
  result.PATH = entries.filter((entry) => {
    if (!entry || seen.has(entry.toLowerCase())) return false;
    seen.add(entry.toLowerCase());
    return true;
  }).join(";");
  return result;
}

/** 子工具优先使用已选的系统 Node；Git/Bash 沿用用户 PATH，rg/fd 仅兜底。 */
export function createServiceRuntimeEnvironment(nodeRoot, toolsRoot, env = process.env, platform = process.platform) {
  const result = createRuntimeEnvironment(toolsRoot, env, platform);
  for (const key of Object.keys(result)) {
    const name = key.toUpperCase();
    if (["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "NEXT_RUNTIME", "TURBOPACK", "WECLIO_DESKTOP_UPDATE_IPC"].includes(name) || name.startsWith("__NEXT_")) delete result[key];
  }
  if (platform === "win32") {
    const entries = [nodeRoot, ...(result.PATH ?? "").split(";")];
    const seen = new Set();
    result.PATH = entries.filter((entry) => {
      if (!entry || seen.has(entry.toLowerCase())) return false;
      seen.add(entry.toLowerCase());
      return true;
    }).join(";");
  } else result.PATH = [nodeRoot, ...(result.PATH ?? "").split(":").filter(Boolean)].join(":");
  return result;
}
