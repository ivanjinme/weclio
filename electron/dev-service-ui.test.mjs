import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { main } from "./dev-service-ui.mjs";

async function listen() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "weclio-dev-ui-"));
  const servers = [await listen(), await listen()];
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  const stateDir = join(cwd, "custom-state");
  mkdirSync(stateDir);
  const env = {
    ...process.env,
    WECLIO_DEV_SERVICE_PORT: String(ports[0]),
    WECLIO_DEV_UI_PORT: String(ports[1]),
    WECLIO_AGENT_STATE_DIR: stateDir,
    WECLIO_AGENT_TOKEN_FILE: join(cwd, "explicit-token"),
  };
  writeFileSync(join(stateDir, "service-token"), "wrong-state-token");
  writeFileSync(env.WECLIO_AGENT_TOKEN_FILE, "exact-token\n");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, env };
}

function readyCode(env) {
  return `process.stdout.write('WECLIO_AGENT_');
    setTimeout(() => process.stdout.write('READY '+JSON.stringify({url:'http://127.0.0.1:${env.WECLIO_DEV_SERVICE_PORT}'})+'\\n'), 30);`;
}

function spawnFixtures(serviceCode, uiCode) {
  const children = [];
  const calls = [];
  return {
    children, calls,
    spawnChild(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(command, process.execPath, "both children use the invoking system Node");
      const child = spawn(command, ["--eval", children.length ? uiCode : serviceCode], options);
      children.push(child);
      return child;
    },
  };
}

async function assertStopped(children) {
  for (const child of children) {
    for (let attempt = 0; attempt < 50; attempt++) {
      let alive = true;
      try { process.kill(child.pid, 0); } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (!alive) break;
      if (attempt === 49) assert.fail(`owned child ${child.pid} survived cleanup`);
      await delay(20);
    }
  }
}

test("import is inert and CLI invocation fails before spawning on an occupied UI port", async (t) => {
  const options = await fixture(t);
  const server = await listen();
  t.after(() => server.close());
  const child = spawn(process.execPath, [fileURLToPath(new URL("./dev-service-ui.mjs", import.meta.url))], {
    env: { ...options.env, WECLIO_DEV_UI_PORT: String(server.address().port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /Port .* unavailable/);
});

for (const occupied of ["WECLIO_DEV_SERVICE_PORT", "WECLIO_DEV_UI_PORT"]) {
  test(`occupied ${occupied} leaves existing server untouched and spawns nothing`, async (t) => {
    const options = await fixture(t);
    const server = await listen();
    t.after(() => server.close());
    options.env[occupied] = String(server.address().port);
    await assert.rejects(main({ ...options, spawnChild() { assert.fail("must not spawn"); } }), /Port .* unavailable/);
    assert.equal(server.listening, true);
  });
}

test("ready event gates UI, uses exact token/config and isolates output without clearing artifacts", async (t) => {
  const options = await fixture(t);
  mkdirSync(join(options.cwd, ".next/dev"), { recursive: true });
  writeFileSync(join(options.cwd, ".next/dev/old-output"), "stale-public-token");
  writeFileSync(join(options.cwd, ".next/dev/lock"), "plain-next-lock");
  mkdirSync(join(options.cwd, "build/dev-service-ui/dev"), { recursive: true });
  writeFileSync(join(options.cwd, "build/dev-service-ui/dev/old-output"), "dedicated-artifact");
  const seen = join(options.cwd, "ui-env.json");
  const ready = join(options.cwd, "ready");
  const children = spawnFixtures(
    `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      process.stdout.write('WECLIO_AGENT_READY '+JSON.stringify({url:'http://127.0.0.1:${options.env.WECLIO_DEV_SERVICE_PORT}'})+'\\n'); }, 100);
      setInterval(() => {}, 1000);`,
    `const fs = require('node:fs');
      if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(8);
      fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env)); process.exit(7);`,
  );
  await assert.rejects(main({ ...options, spawnChild: children.spawnChild }), /\[ui\] exited \(7\)/);
  const uiEnv = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(uiEnv.NEXT_PUBLIC_WECLIO_AGENT_TOKEN, "exact-token");
  assert.equal(uiEnv.NEXT_PUBLIC_WECLIO_API_URL, `http://127.0.0.1:${options.env.WECLIO_DEV_SERVICE_PORT}`);
  assert.equal(uiEnv.NEXT_PUBLIC_WECLIO_API_BASE_PATH, "/v1");
  assert.equal(children.calls[0].options.env.WECLIO_AGENT_STATE_DIR, options.env.WECLIO_AGENT_STATE_DIR);
  assert.equal(children.calls[0].options.env.WECLIO_AGENT_TOKEN_FILE, options.env.WECLIO_AGENT_TOKEN_FILE);
  assert.equal(children.calls[0].options.env.WECLIO_AGENT_HOST, "127.0.0.1");
  assert.equal(uiEnv.WECLIO_DEV_UI_DIST_DIR, "build/dev-service-ui");
  assert.equal(readFileSync(join(options.cwd, ".next/dev/old-output"), "utf8"), "stale-public-token");
  assert.equal(readFileSync(join(options.cwd, ".next/dev/lock"), "utf8"), "plain-next-lock");
  assert.equal(readFileSync(join(options.cwd, "build/dev-service-ui/dev/old-output"), "utf8"), "dedicated-artifact");
  await assertStopped(children.children);
});

test("stale token without readiness times out without starting UI", async (t) => {
  const options = await fixture(t);
  const children = spawnFixtures("setInterval(() => {}, 1000)", "process.exit(9)");
  await assert.rejects(main({ ...options, spawnChild: children.spawnChild, timeoutMs: 100 }), /Timed out waiting/);
  assert.equal(children.children.length, 1);
  await assertStopped(children.children);
});

test("service exit before readiness fails immediately even with an existing token", async (t) => {
  const options = await fixture(t);
  const children = spawnFixtures("process.exit(0)", "process.exit(9)");
  await assert.rejects(main({ ...options, spawnChild: children.spawnChild }), /\[service\] exited \(0\)/);
  assert.equal(children.children.length, 1);
  await assertStopped(children.children);
});

test("split readiness event is parsed and missing token fails closed", async (t) => {
  const options = await fixture(t);
  rmSync(options.env.WECLIO_AGENT_TOKEN_FILE);
  const children = spawnFixtures(`${readyCode(options.env)} setInterval(() => {}, 1000);`, "process.exit(9)");
  await assert.rejects(main({ ...options, spawnChild: children.spawnChild }), /ENOENT/);
  assert.equal(children.children.length, 1);
  await assertStopped(children.children);
});

test("UI spawn error cleans service tree but leaves unrelated Node alive", async (t) => {
  const options = await fixture(t);
  const unrelated = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill());
  const grandchildFile = join(options.cwd, "grandchild");
  const children = spawnFixtures(
    `const child = require('node:child_process').spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(child.pid));
      ${readyCode(options.env)} setInterval(() => {}, 1000);`, "",
  );
  const spawnChild = (command, args, opts) => children.children.length
    ? spawn(join(options.cwd, "missing-node"), args, opts)
    : children.spawnChild(command, args, opts);
  await assert.rejects(main({ ...options, spawnChild }), /\[ui\].*ENOENT/);
  await assertStopped([...children.children, { pid: Number(readFileSync(grandchildFile, "utf8")) }]);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("service exit after readiness tears down the running UI too", async (t) => {
  const options = await fixture(t);
  const uiStarted = join(options.cwd, "ui-started");
  const children = spawnFixtures(
    `${readyCode(options.env)}
      setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(uiStarted)})) process.exit(4); }, 20);`,
    `require('node:fs').writeFileSync(${JSON.stringify(uiStarted)}, 'started'); setInterval(() => {}, 1000);`,
  );
  await assert.rejects(main({ ...options, spawnChild: children.spawnChild }), /\[service\] exited \(4\)/);
  assert.equal(children.children.length, 2);
  await assertStopped(children.children);
});

test("invalid or equal ports fail before spawning", async (t) => {
  const options = await fixture(t);
  for (const value of ["0", "NaN", "65536", options.env.WECLIO_DEV_SERVICE_PORT]) {
    await assert.rejects(main({
      ...options,
      env: { ...options.env, WECLIO_DEV_UI_PORT: value },
      spawnChild() { assert.fail("must not spawn"); },
    }), /Invalid port|ports must differ/);
  }
});

test("active dedicated Next output lock is never removed", async (t) => {
  const options = await fixture(t);
  mkdirSync(join(options.cwd, "build/dev-service-ui/dev"), { recursive: true });
  const lock = join(options.cwd, "build/dev-service-ui/dev/lock");
  writeFileSync(lock, "");
  await assert.rejects(main({ ...options, spawnChild() { assert.fail("must not spawn"); } }), /output is locked/);
  assert.equal(existsSync(lock), true);
});
