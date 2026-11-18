import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// 身份与数据归属：serviceId 跨重启稳定，instanceId 每次启动变化。
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti");

async function bootstrap(root) {
  const entry = join(repoRoot, "lib", "agent", "service", "entry.ts");
  const path = join(root, "bootstrap.mjs");
  await writeFile(path, `import { createJiti } from ${JSON.stringify(pathToFileURL(jitiPath).href)};
const jiti = createJiti(import.meta.url);
const entry = await jiti.import(${JSON.stringify(pathToFileURL(entry).href)});
await entry.main();
`);
  return path;
}

function env(root) {
  const home = join(root, "home");
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key))),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: root,
    TMP: root,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    WECLIO_AGENT_STATE_DIR: join(root, "state"),
    WECLIO_AGENT_WORKSPACE: join(root, "workspace"),
    WECLIO_AGENT_PORT: "0",
    WECLIO_AGENT_DRAIN_TIMEOUT_MS: "3000",
    NODE_ENV: "test",
  };
}

/** 启动一次 Service，读取 ready 行后立即通过 stdin 关闭。 */
async function runOnce(root, script, environment) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready\n${stdout}\n${stderr}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("WECLIO_AGENT_READY "));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice("WECLIO_AGENT_READY ".length)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited before ready (${code})\n${stdout}\n${stderr}`));
    });
  });

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.write("shutdown\n");
  const code = await exited;
  return { ready, code };
}

test("service identity survives restart while the instance id changes", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-agent-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = env(root);
  await mkdir(environment.PI_CODING_AGENT_DIR, { recursive: true });
  await mkdir(environment.WECLIO_AGENT_WORKSPACE, { recursive: true });
  const script = await bootstrap(root);

  const first = await runOnce(root, script, environment);
  assert.equal(first.code, 0);
  assert.match(first.ready.serviceId, /^[0-9a-f-]{36}$/);
  assert.match(first.ready.instanceId, /^[0-9a-f-]{36}$/);

  const identityPath = join(environment.WECLIO_AGENT_STATE_DIR, "service.json");
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  assert.equal(identity.serviceId, first.ready.serviceId);
  assert.equal(identity.instanceId, first.ready.instanceId);
  assert.equal(identity.protocolVersion, 1);
  assert.equal(typeof identity.pid, "number");

  const second = await runOnce(root, script, environment);
  assert.equal(second.code, 0);

  // serviceId 是环境身份，重启必须保留；instanceId 标识这一次启动。
  assert.equal(second.ready.serviceId, first.ready.serviceId);
  assert.notEqual(second.ready.instanceId, first.ready.instanceId);

  const rewritten = JSON.parse(await readFile(identityPath, "utf8"));
  assert.equal(rewritten.serviceId, first.ready.serviceId);
  assert.equal(rewritten.instanceId, second.ready.instanceId);
});

test("stale diagnostic metadata does not claim a state directory", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-agent-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = env(root);
  await mkdir(environment.PI_CODING_AGENT_DIR, { recursive: true });
  await mkdir(environment.WECLIO_AGENT_WORKSPACE, { recursive: true });
  const script = await bootstrap(root);

  // PID 仍存活也不代表持有 OS 锁。
  await mkdir(environment.WECLIO_AGENT_STATE_DIR, { recursive: true });
  await writeFile(
    join(environment.WECLIO_AGENT_STATE_DIR, "owner.json"),
    JSON.stringify({ pid: process.pid, instanceId: "held-by-test" }),
  );

  const started = await runOnce(root, script, environment);
  assert.equal(started.code, 0);
  await assert.rejects(readFile(join(environment.WECLIO_AGENT_STATE_DIR, "owner.json")), { code: "ENOENT" });
});
