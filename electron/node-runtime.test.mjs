import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fileSha256, NODE_RUNTIME, verifyNodeRuntime } from "./node-runtime.mjs";
import { createServiceRuntimeEnvironment } from "./runtime.mjs";

const root = fileURLToPath(new URL("../resources/runtime/win-x64/node", import.meta.url));

test("Runtime pin binds full official distribution and executable separately", () => {
  assert.equal(NODE_RUNTIME.version, "24.16.0");
  assert.equal(new URL(NODE_RUNTIME.url).hostname, "nodejs.org");
  assert.equal(NODE_RUNTIME.arch, "x64");
  assert.match(NODE_RUNTIME.sha256, /^[a-f0-9]{64}$/);
  assert.match(NODE_RUNTIME.nodeSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(NODE_RUNTIME.sha256, NODE_RUNTIME.nodeSha256);
});

test("missing, malformed and version-mismatched receipts cannot authorize Runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "weclio-node-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(verifyNodeRuntime(directory), /ENOENT/);
  await writeFile(join(directory, "runtime-manifest.json"), "{");
  await assert.rejects(verifyNodeRuntime(directory), SyntaxError);
  await writeFile(join(directory, "runtime-manifest.json"), JSON.stringify({ schema: 1, version: "1.0.0", archiveSha256: NODE_RUNTIME.sha256, files: [] }));
  await assert.rejects(verifyNodeRuntime(directory), /Invalid Node Runtime manifest/);
});

test("extra or changed files cannot pass a completion receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "weclio-node-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "extra.js"), "unexpected");
  await writeFile(join(directory, "runtime-manifest.json"), JSON.stringify({ schema: 1, version: NODE_RUNTIME.version, archiveSha256: NODE_RUNTIME.sha256, files: [] }));
  await assert.rejects(verifyNodeRuntime(directory), /integrity mismatch/);
  assert.equal((await fileSha256(join(directory, "extra.js"))).length, 64);
});

test("prepared official Runtime runs Node/npm/npx and child Node without system Node on PATH", {
  skip: process.platform !== "win32" || !existsSync(join(root, "runtime-manifest.json")), timeout: 60000,
}, async () => {
  const verified = await verifyNodeRuntime(root);
  const env = createServiceRuntimeEnvironment(root, fileURLToPath(new URL("../resources/runtime/win-x64", import.meta.url)), {
    PATH: join(process.env.SystemRoot, "System32"), SystemRoot: process.env.SystemRoot,
  });
  const run = promisify(execFile);
  const info = JSON.parse((await run(verified.executable, ["-p", "JSON.stringify({version:process.versions.node,electron:process.versions.electron??null})"], { env, windowsHide: true })).stdout);
  assert.deepEqual(info, { version: NODE_RUNTIME.version, electron: null });
  for (const filename of ["npm-cli.js", "npx-cli.js"]) {
    const result = await run(verified.executable, [join(root, "node_modules/npm/bin", filename), "--version"], { env, windowsHide: true });
    assert.equal(result.stdout.trim(), verified.npmVersion);
  }
  const child = await run(verified.executable, ["-p", "require('node:child_process').execFileSync('node.exe',['-p','process.execPath'],{encoding:'utf8'}).trim()"], { env, windowsHide: true });
  assert.equal(child.stdout.trim().toLowerCase(), verified.executable.toLowerCase());
});
