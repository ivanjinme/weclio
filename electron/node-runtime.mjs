import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// 来源与摘要来自官方 v24.16.0/SHASUMS256.txt；升级 Runtime 必须显式更新 pin 并重做产物回归。
export const NODE_RUNTIME = Object.freeze({
  version: "24.16.0", platform: "win32", arch: "x64",
  archive: "node-v24.16.0-win-x64.zip",
  url: "https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip",
  shasums: "https://nodejs.org/dist/v24.16.0/SHASUMS256.txt",
  sha256: "edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56",
  nodeSha256: "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3",
});
const RECEIPT = "runtime-manifest.json";
const REQUIRED = ["node.exe", "npm.cmd", "npx.cmd", "node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npx-cli.js", "node_modules/npm/package.json", "LICENSE"];
const run = promisify(execFile);
const missing = (error) => error.code === "ENOENT";

export async function fileSha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function safePath(name) {
  return typeof name === "string" && name.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\:\x00-\x1f]/.test(part));
}
async function listFiles(root, prefix = "") {
  const files = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!safePath(path)) throw new Error(`Invalid Node Runtime path: ${path}`);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Linked Node Runtime file: ${path}`);
    if (info.isDirectory()) files.push(...await listFiles(root, path));
    else if (info.isFile() && path !== RECEIPT) files.push({ path, size: info.size, sha256: await fileSha256(join(root, path)) });
    else if (!info.isFile()) throw new Error(`Irregular Node Runtime file: ${path}`);
  }
  return files;
}

export async function verifyNodeRuntime(root) {
  const receipt = JSON.parse(await readFile(join(root, RECEIPT), "utf8"));
  if (receipt.schema !== 1 || receipt.version !== NODE_RUNTIME.version || receipt.archiveSha256 !== NODE_RUNTIME.sha256 || !Array.isArray(receipt.files)) throw new Error("Invalid Node Runtime manifest");
  const actual = await listFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.files)) throw new Error("Node Runtime file integrity mismatch");
  const names = new Set(actual.map((file) => file.path));
  if (REQUIRED.some((name) => !names.has(name)) || actual.find((file) => file.path === "node.exe")?.sha256 !== NODE_RUNTIME.nodeSha256) throw new Error("Incomplete Node/npm Runtime");
  const npm = JSON.parse(await readFile(join(root, "node_modules/npm/package.json"), "utf8"));
  if (npm.name !== "npm" || npm.version !== receipt.npmVersion) throw new Error("Invalid bundled npm metadata");
  return { root: resolve(root), executable: join(resolve(root), "node.exe"), npmVersion: npm.version };
}

/** 官方完整 ZIP 同时携带 Node/npm/npx/shims/许可证；只放进自有资源目录，不安装到系统。 */
export async function prepareNodeRuntime({ destination, cacheDir, fetchImpl = fetch } = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Node Runtime preparation currently requires Windows x64");
  try { return await verifyNodeRuntime(destination); }
  catch (error) { if (!missing(error)) throw error; }
  await mkdir(cacheDir, { recursive: true });
  const archive = join(cacheDir, NODE_RUNTIME.archive);
  try { await lstat(archive); }
  catch (error) {
    if (!missing(error)) throw error;
    const response = await fetchImpl(NODE_RUNTIME.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Node Runtime download failed: HTTP ${response.status}`);
    const temporary = `${archive}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      if (await fileSha256(temporary) !== NODE_RUNTIME.sha256) throw new Error("Node Runtime archive checksum mismatch");
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await fileSha256(archive) !== NODE_RUNTIME.sha256) throw new Error("Cached Node Runtime archive checksum mismatch");
  // 使用 Windows 自带的 tar.exe 解压 ZIP，不依赖 PowerShell 或引入解压依赖。
  const tar = join(process.env.SystemRoot, "System32", "tar.exe");
  const listing = await run(tar, ["-tf", archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const prefix = `node-v${NODE_RUNTIME.version}-win-x64`;
  if (listing.stdout.split(/\r?\n/).filter(Boolean).some((name) => !name.startsWith(`${prefix}/`) || name.split("/").includes("..") || name.includes("\\"))) throw new Error("Invalid Node Runtime archive layout");
  const temporary = await mkdtemp(join(cacheDir, "node-extract-"));
  try {
    await run(tar, ["-xf", archive, "-C", temporary], { windowsHide: true });
    const extracted = join(temporary, prefix);
    const files = await listFiles(extracted);
    const npm = JSON.parse(await readFile(join(extracted, "node_modules/npm/package.json"), "utf8"));
    const manifest = { schema: 1, version: NODE_RUNTIME.version, npmVersion: npm.version, source: NODE_RUNTIME.url, archiveSha256: NODE_RUNTIME.sha256, files };
    await writeFile(join(extracted, RECEIPT), JSON.stringify(manifest, null, 2) + "\n");
    await verifyNodeRuntime(extracted);
    // 发布之前不覆盖已有目录，损坏或残缺的旧资源必须由构建者显式处理。
    await rename(extracted, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return verifyNodeRuntime(destination);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prepared = await prepareNodeRuntime({ destination: join(root, "resources/runtime/win-x64/node"), cacheDir: join(root, "build/runtime-downloads") });
  console.log(`[runtime] Node ${NODE_RUNTIME.version}, npm ${prepared.npmVersion} ready: ${prepared.root}`);
}
