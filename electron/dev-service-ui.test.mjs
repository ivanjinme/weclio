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
    ELECTRON_RUN_AS_NODE: "1",
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
  for (const call of children.calls) assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
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

function desktopFixtures(options, uiCode, desktopCode = "process.exit(0)") {
  const calls = [];
  const children = [];
  const scripts = [`${readyCode(options.env)} setInterval(() => {}, 1000);`, uiCode, desktopCode];
  return {
    calls, children,
    spawnChild(command, args, childOptions) {
      const index = calls.length;
      calls.push({ command, args, options: childOptions });
      assert.equal(command, index < 2 ? process.execPath : "fixture-electron");
      const child = spawn(process.execPath, ["--eval", scripts[index]], childOptions);
      children.push(child);
      return child;
    },
  };
}

function httpUiCode(options) {
  return `require('node:http').createServer((req, res) => res.end('fixture UI'))
    .listen(${options.env.WECLIO_DEV_UI_PORT ?? options.env.PORT}, '127.0.0.1', () => console.log('Ready in 1ms'));`;
}

for (const httpFirst of [false, true]) {
  test(`desktop is visible only after service bootstrap, current UI announcement and HTTP (${httpFirst ? "HTTP first" : "announcement first"})`, async (t) => {
    const options = await fixture(t);
    const uiPort = options.env.WECLIO_DEV_UI_PORT;
    // PORT 兼容保留，同时显式 UI 端口的优先级不变。
    if (httpFirst) delete options.env.WECLIO_DEV_UI_PORT;
    options.env.PORT = httpFirst ? uiPort : "1";
    const announced = join(options.cwd, "announced");
    const responded = join(options.cwd, "responded");
    const guiEnvFile = join(options.cwd, "gui-env");
    const uiCode = `const fs = require('node:fs');
      function announce() {
        fs.writeFileSync(${JSON.stringify(announced)}, 'yes');
        process.stdout.write('Rea'); setTimeout(() => console.log('dy in 1ms'), 20);
      }
      function listen() {
        require('node:http').createServer((req, res) => {
          fs.writeFileSync(${JSON.stringify(responded)}, 'yes'); res.end('fixture UI');
        }).listen(${uiPort}, '127.0.0.1');
      }
      ${httpFirst ? "listen(); setTimeout(announce, 150);" : "announce(); setTimeout(listen, 150);"}`;
    const children = desktopFixtures(options, uiCode, `const fs = require('node:fs');
      if (!fs.existsSync(${JSON.stringify(announced)}) || !fs.existsSync(${JSON.stringify(responded)})) process.exit(8);
      fs.writeFileSync(${JSON.stringify(guiEnvFile)}, JSON.stringify(process.env)); process.exit(0);`);
    const output = [];
    await main({ ...options, spawnChild: children.spawnChild,
      desktop: { executable: "fixture-electron", args: ["main.mjs", "--fixture"] }, onOutput: (chunk) => output.push(chunk) });
    assert.equal(children.calls.length, 3);
    assert.deepEqual(children.calls[2].args, ["main.mjs", "--fixture"]);
    for (const [index, call] of children.calls.entries()) {
      assert.equal(call.options.windowsHide, index !== 2);
      assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(call.options.detached, process.platform !== "win32");
    }
    const uiUrl = `http://127.0.0.1:${uiPort}`;
    assert.equal(children.calls[0].options.env.WECLIO_AGENT_ALLOWED_ORIGINS, uiUrl);
    assert.equal(children.calls[1].options.env.NEXT_PUBLIC_WECLIO_AGENT_TOKEN, "exact-token");
    const guiEnv = JSON.parse(readFileSync(guiEnvFile, "utf8"));
    assert.equal(guiEnv.WECLIO_DESKTOP_URL, uiUrl);
    assert.equal(guiEnv.NEXT_PUBLIC_WECLIO_AGENT_TOKEN, undefined);
    assert.ok(output.some((chunk) => chunk.includes("WECLIO_AGENT_")));
    await assertStopped(children.children);
  });
}

for (const uiCode of [
  "process.exit(6)",
  "setInterval(() => {}, 1000)",
  "console.log('Ready in 1ms'); setInterval(() => {}, 1000)",
  "require('node:http').createServer((req, res) => res.end('not announced')).listen(Number(process.env.WECLIO_DEV_UI_PORT), '127.0.0.1')",
]) {
  test(`UI startup failure never launches desktop: ${uiCode}`, async (t) => {
    const options = await fixture(t);
    const children = desktopFixtures(options, uiCode);
    await assert.rejects(main({ ...options, spawnChild: children.spawnChild, timeoutMs: 500, uiTimeoutMs: 500,
      desktop: { executable: "fixture-electron" } }), /\[ui\] exited \(6\)|Next 服务在 .* 秒内未就绪/);
    assert.equal(children.calls.length, 2);
    await assertStopped(children.children);
  });
}

for (const spawnError of [false, true]) {
  test(`desktop ${spawnError ? "spawn error" : "nonzero exit"} fails and stops owned Service and UI`, async (t) => {
    const options = await fixture(t);
    const children = desktopFixtures(options, httpUiCode(options), "process.exit(7)");
    const spawnChild = (command, args, opts) => command === "fixture-electron" && spawnError
      ? spawn(join(options.cwd, "missing-electron"), args, opts)
      : children.spawnChild(command, args, opts);
    await assert.rejects(main({ ...options, spawnChild, desktop: { executable: "fixture-electron" } }), /\[desktop\].*(ENOENT|exited \(7\))/);
    await assertStopped(children.children);
  });
}

for (const forceExit of [false, true]) {
  test(`supervisor ${forceExit ? "process.exit" : "SIGINT"} stops its own children and descendants, not unrelated Node`, async (t) => {
    const options = await fixture(t);
    const pidsFile = join(options.cwd, "owned-pids");
    const descendantFile = join(options.cwd, "descendant-pid");
    const unrelated = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => unrelated.kill());
    const serviceCode = `const child = require('node:child_process').spawn(process.execPath,
      ['--eval', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
      ${readyCode(options.env)} setInterval(() => {}, 1000);`;
    const script = `import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { main } from ${JSON.stringify(new URL("./dev-service-ui.mjs", import.meta.url).href)};
      const scripts = ${JSON.stringify([serviceCode, httpUiCode(options), "setInterval(() => {}, 1000)"])};
      const pids = [];
      await main({ cwd: ${JSON.stringify(options.cwd)}, env: process.env,
        desktop: { executable: 'fixture-electron' },
        spawnChild(command, args, opts) {
          const child = spawn(process.execPath, ['--eval', scripts[pids.length]], opts);
          pids.push(child.pid);
          writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify(pids));
          if (pids.length === 3) setTimeout(() => ${forceExit ? "process.exit(0)" : "process.emit('SIGINT')"}, 150);
          return child;
        }
      });`;
    const supervisor = spawn(process.execPath, ["--input-type=module", "--eval", script], { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    supervisor.stderr.on("data", (chunk) => { stderr += chunk; });
    supervisor.stdout.resume();
    const [code] = await once(supervisor, "exit");
    assert.equal(code, 0, stderr);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8"));
    assert.equal(pids.length, 3);
    pids.push(Number(readFileSync(descendantFile, "utf8")));
    await assertStopped(pids.map((pid) => ({ pid })));
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  });
}
