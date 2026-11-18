import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodeVersion from "../bin/node-version.js";
import { prepareSignedUpdate, readReleaseSigning } from "./update-release.mjs";
import { createToolsetManifest } from "./toolsets.mjs";
export { validateInstaller } from "./update-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const inputs = ["app", "desktop", "components", "hooks", "lib", "public", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", "vite.config.ts", "package.json", "package-lock.json", "LICENSE", "electron/build.mjs", "electron/service-build.mjs", "electron/package-files.mjs", "electron/toolsets.mjs"];

export function fingerprintDesktopResources(base) {
  return fingerprint(base, ["ui", "service", "host"]);
}

export async function fingerprint(base, paths = inputs) {
  const hash = createHash("sha256");
  async function add(file) {
    const metadata = await stat(file);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await add(join(file, name));
      return;
    }
    hash.update(JSON.stringify([relative(base, file).replaceAll("\\", "/"), metadata.size]));
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  for (const name of paths) await add(join(base, name));
  return hash.digest("hex");
}

export function fingerprintPackaging(base) {
  return fingerprint(base, ["electron", "bin/node-version.js", "resources/desktop-update.json", "resources/runtime/win-x64/tools"]);
}

export async function validateVersion(base) {
  const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(base, "package-lock.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package.json 与 package-lock.json 的版本不一致或无效。");
  }
  return pkg.version;
}

export async function retainDesktopRelease({ output, dist, version, signing }) {
  const name = `Weclio-${version}-x64-Setup.exe`;
  const installerPath = join(output, name);
  const blockmapPath = `${installerPath}.blockmap`;
  // 所有产物校验与签名成功后，才开始替换 dist；更新清单最后就位。
  const prepared = await prepareSignedUpdate({ version, installerPath, blockmapPath, signing });
  const manifestHash = createHash("sha256").update(prepared.manifest).digest("hex");
  const sums = `${prepared.sha256}  ${name}\n${prepared.blockmapSha256}  ${name}.blockmap\n${manifestHash}  ${prepared.manifestName}\n`;
  await mkdir(dist, { recursive: true });
  const stage = await mkdtemp(join(dist, ".release-"));
  try {
    await cp(installerPath, join(stage, name));
    await cp(blockmapPath, join(stage, `${name}.blockmap`));
    await writeFile(join(stage, prepared.manifestName), prepared.manifest);
    await writeFile(join(stage, "SHA256SUMS.txt"), sums);
    for (const file of [name, `${name}.blockmap`, "SHA256SUMS.txt", prepared.manifestName]) {
      await rename(join(stage, file), join(dist, file));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { installerPath: join(dist, name), blockmapPath: join(dist, `${name}.blockmap`), manifestPath: join(dist, prepared.manifestName), sha256: prepared.sha256 };
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`命令失败 (${code ?? signal}): ${args.join(" ")}`)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--quick") || args.length > 1) throw new Error("用法: npm run release:desktop [-- --quick]");
  if (process.platform !== "win32" || process.arch !== "x64" || !nodeVersion.isNodeVersionSupported(process.versions.node)) throw new Error("需要 Windows x64 和 Node.js 22.19+。");
  const version = await validateVersion(root);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.split(".").some((part) => !Number.isSafeInteger(Number(part)))) throw new Error("桌面更新仅接受正式版本号。");
  const packagingFingerprint = await fingerprintPackaging(root);
  const signing = await readReleaseSigning({ root });
  const resources = join(root, "build/desktop");
  const snapshot = join(resources, "resources-inputs.json");
  const dist = join(root, "build/desktop/dist");
  const initial = await fingerprint(root);
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await run(process.execPath, [npm, "ls", "--omit=dev", "--all", "--parseable"]);
  const tests = (await readdir(join(root, "electron"))).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(root, "electron", name));
  await run(process.execPath, ["--test", "--test-concurrency=4", ...tests]);
  if (args.includes("--quick")) {
    if (!existsSync(snapshot)) throw new Error("没有完整发布构建记录，请先执行 npm run release:desktop。");
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    if (saved.fingerprint !== initial || saved.version !== version || saved.resources !== await fingerprintDesktopResources(resources)) throw new Error("生产构建输入或产物已变化，请执行完整发布。");
  } else {
    await rm(snapshot, { force: true });
    await run(process.execPath, [join(root, "electron/build.mjs")]);
    if (await fingerprint(root) !== initial) throw new Error("构建过程中源文件变化，请重新执行。");
    const resourcesHash = await fingerprintDesktopResources(resources);
    await writeFile(snapshot, JSON.stringify({ version, fingerprint: initial, resources: resourcesHash }) + "\n");
  }
  // 发行不能把默认跳过的产物测试当成已验收：始终用真实候选闭包和系统 Node 跑隔离工具循环。
  await run(process.execPath, ["--test", "--test-concurrency=4", join(root, "electron/service-artifact.integration.test.mjs")], {
    ...process.env, WECLIO_SERVICE_ARTIFACT: join(resources, "service"),
  });
  // --quick 可复用服务构建，但工具描述必须绑定本次实际打包的工具。
  if (args.includes("--quick")) {
    await writeFile(join(root, "build/desktop/toolset.json"), JSON.stringify(await createToolsetManifest(join(root, "resources/runtime/win-x64"))) + "\n");
  }
  await mkdir(join(root, "build/desktop"), { recursive: true });
  const generatedFingerprint = await fingerprint(root, ["build/desktop/toolset.json"]);
  const output = await mkdtemp(join(root, "build/desktop/release-"));
  try {
    const builder = require.resolve("electron-builder/cli.js");
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    await run(process.execPath, [builder, "--config", "electron/builder.json", "--win", "--x64", "--publish", "never", "--config.directories.output", output]);
    if (await fingerprint(root) !== initial || await fingerprintPackaging(root) !== packagingFingerprint || await fingerprint(root, ["build/desktop/toolset.json"]) !== generatedFingerprint || saved.resources !== await fingerprintDesktopResources(resources)) throw new Error("打包过程中源文件或构建产物变化，请重新执行。");
    const result = await retainDesktopRelease({ output, dist, version, signing });
    console.log(`\n安装包: ${result.installerPath}\n差异文件: ${result.blockmapPath}\n签名清单: ${result.manifestPath}\nSHA256: ${result.sha256}\n本命令不会上传。`);
  } finally {
    await rm(output, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[desktop-release] ${error.message}`); process.exitCode = 1; });
}
