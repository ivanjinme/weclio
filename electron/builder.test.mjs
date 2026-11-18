import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMatcher, copyFiles } from "app-builder-lib/out/fileMatcher.js";
import { AppInfo } from "app-builder-lib/out/appInfo.js";
import { fileURLToPath } from "node:url";
import { loadUpdateConfig, makeDownloadOnlyUpdater } from "./updates.mjs";

const config = JSON.parse(await readFile(new URL("./builder.json", import.meta.url), "utf8"));

test("Service dependencies have a dedicated resource mapping, including nested dependencies and assets", async (t) => {
  const mapping = config.extraResources.find((entry) => entry.to === "service/node_modules");
  assert.equal(mapping?.from, "build/desktop/service/node_modules");
  assert.equal(config.extraResources.find((entry) => entry.to === "host/node_modules")?.from, "build/desktop/host/node_modules");
  const root = await mkdtemp(join(tmpdir(), "weclio-resource-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "node_modules");
  const destination = join(root, "resources/service/node_modules");
  const files = ["sdk/dist/index.js", "sdk/node_modules/dependency/index.js", "sdk/resource.wasm", "sdk/LICENSE",
    "@weclio/plugins/extensions/pi-citations/index.ts", "@weclio/plugins/LICENSE",
    "@weclio/plugins/extensions/pi-submarine/src/index.ts", "@weclio/plugins/extensions/pi-submarine/LICENSE",
    "@weclio/plugins/extensions/pi-submarine/NOTICE.md", "@weclio/plugins/extensions/pi-web-search/index.ts"];
  for (const file of files) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  // builder 对映射根目录下的 node_modules 有特殊过滤，必须从目录本身开始复制。
  await copyFiles([new FileMatcher(source, destination, (value) => value, ["**/*"])]);
  for (const file of files) assert.equal(await readFile(join(destination, file), "utf8"), file);
});

test("installer updater packages only its runtime modules, not obsolete application or build-only modules", () => {
  assert.deepEqual(config.files, [
    "electron/main.mjs", "lib/startup-splash.mjs", "electron/navigation.mjs", "electron/protocol.mjs", "electron/preload.cjs",
    "electron/updates.mjs", "electron/update-signature.mjs", "electron/update-install.mjs",
    "electron/local-service.mjs", "electron/service-control.mjs", "electron/system-node.mjs", "bin/node-version.js", "lib/agent/protocol/version-value.mjs",
    "electron/runtime.mjs", "electron/toolsets.mjs", "LICENSE", "!node_modules/**/*",
  ]);
  assert.deepEqual(config.extraResources.find((entry) => entry.from === "resources"), { from: "resources", to: ".", filter: ["desktop-update.json"] });
});

test("Service resources contain compiled code and manifests, never Next or development source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-server-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "service");
  const destination = join(root, "copied");
  const kept = ["package.json", "entry.mjs", "service-manifest.json", "LICENSE", "lib/agent/service/entry.js", "lib/agent/protocol/version-value.mjs"];
  const omitted = ["next.config.js", "app/page.tsx", "components/private.tsx", ".env", "tsconfig.json", ".next/BUILD_ID", ".next/server/app/api/test/route.js"];
  for (const file of [...kept, ...omitted]) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  const mapping = config.extraResources.find((entry) => entry.to === "service");
  await copyFiles([new FileMatcher(source, destination, (value) => value, mapping.filter)]);
  for (const file of kept) assert.equal(await readFile(join(destination, file), "utf8"), file);
  for (const file of omitted) await assert.rejects(readFile(join(destination, file)), { code: "ENOENT" });
});

test("bootstrap installer ships a generated toolset descriptor separately from trust config", () => {
  assert.deepEqual(config.extraResources.find((entry) => entry.to === "desktop-toolset.json"), { from: "build/desktop/toolset.json", to: "desktop-toolset.json" });
});

test("installer has no obsolete shell descriptor or business package resources", () => {
  assert.deepEqual(config.extraResources.map((entry) => entry.to), [".", "ui", "service", "service/node_modules", "host", "host/node_modules", "desktop-toolset.json", "runtime/win-x64"]);
});

test("production updater cache matches the installer cache instead of the development fallback", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packager = new AppInfo({ metadata: { ...pkg, ...config.extraMetadata }, config });
  const runtime = await loadUpdateConfig({ packaged: true, resourcesPath: fileURLToPath(new URL("../resources/", import.meta.url)) });
  assert.equal(runtime.updaterCacheDirName, packager.updaterCacheDirName);
  const Updater = makeDownloadOnlyUpdater(class {}, runtime.updaterCacheDirName);
  assert.equal((await new Updater().loadUpdateConfig()).updaterCacheDirName, packager.updaterCacheDirName);
});

test("desktop metadata supplies the branded Windows shortcut description", () => {
  assert.equal(config.extraMetadata.description, "Weclio - Build an AI Scientist");
});

test("Service and tools stay outside asar; no Node/npm Runtime or Next server", () => {
  assert.ok(config.files.includes("electron/local-service.mjs"));
  assert.ok(config.files.includes("!node_modules/**/*"));
  assert.deepEqual(config.extraResources.find((entry) => entry.to === "runtime/win-x64").filter, ["tools/**/*"]);
  assert.ok(!config.extraResources.some((entry) => /runtime\/win-x64\/node/.test(entry.to)));
  assert.equal(config.extraResources.some((entry) => entry.to.startsWith("server")), false);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("every relative import of a packaged main-process module is itself packaged", async () => {
  // asar 只包含 files 里显式列出的文件；漏一个就会在用户机器上变成
  // ERR_MODULE_NOT_FOUND（本地测试直接读磁盘，永远发现不了）。
  const packaged = config.files.filter((name) => !name.startsWith("!"));
  const list = new Set(packaged.map((name) => name.replaceAll("\\", "/")));
  const modules = packaged.filter((name) => /\.(?:mjs|cjs|js)$/.test(name));
  assert.ok(modules.length > 10, "expected a substantial packaged module list");
  for (const name of modules) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const relative = join("electron", match[1]).replaceAll("\\", "/");
      const resolved = relative.startsWith("electron/../")
        ? relative.slice("electron/".length)
        : relative;
      assert.ok(list.has(resolved), `${name} imports ${match[1]}, which is not in builder.json files`);
    }
  }
});
