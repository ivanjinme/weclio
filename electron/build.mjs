import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildHostArtifact, buildServiceArtifact } from "./service-build.mjs";
import { createToolsetManifest } from "./toolsets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "build/desktop");

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("桌面构建目前仅支持 Windows x64。");
  const runtime = join(root, "resources/runtime/win-x64");
  for (const file of ["tools/rg.exe", "tools/fd.exe"]) {
    if (!existsSync(join(runtime, file))) throw new Error(`请先准备 resources/runtime/win-x64/${file}`);
  }
  await mkdir(output, { recursive: true });
  // 只替换本脚本的候选资源；不碰 dev 的静态 UI、Next 输出、已有 installer 或用户数据。
  for (const name of ["service", "host", "ui"]) await rm(join(output, name), { recursive: true, force: true, maxRetries: 3 });
  const service = await buildServiceArtifact({ destination: join(output, "service") });
  await buildHostArtifact({ destination: join(output, "host") });
  await build({ configFile: join(root, "vite.config.ts"), build: { outDir: join(output, "ui"), emptyOutDir: true } });
  await cp(join(root, "LICENSE"), join(output, "host/LICENSE"));
  await writeFile(join(output, "toolset.json"), JSON.stringify(await createToolsetManifest(runtime)) + "\n");
  console.log(`[desktop] 静态 UI + Service (${service.packages.length} runtime packages) + Host 准备完成（使用系统 Node.js）。`);
} catch (error) {
  console.error(`[desktop] ${error.message}`);
  process.exitCode = 1;
}
