import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
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

for (const held of [false, true]) {
  test(`Next arbitrates a ${held ? "held" : "leftover"} dedicated output lock and the supervisor stops its Service`, async (t) => {
    const require = createRequire(import.meta.url);
    const swc = require.resolve("next/dist/build/swc");
    const lockfile = require.resolve("next/dist/build/lockfile");
    const { isWasm } = await require(swc).loadBindings();
    if (isWasm) return t.skip("Next's WASM bindings do not lock the output directory");
    const { Lockfile } = require(lockfile);
    const options = await fixture(t);
    mkdirSync(join(options.cwd, "build/dev-service-ui/dev"), { recursive: true });
    const lockPath = join(options.cwd, "build/dev-service-ui/dev/lock");
    writeFileSync(lockPath, "leftover");
    const lock = held ? Lockfile.tryAcquire(lockPath, false, "active owner") : undefined;
    if (held) assert.ok(lock);
    const children = spawnFixtures(`${readyCode(options.env)} setInterval(() => {}, 1000);`, `
      require(${JSON.stringify(swc)}).loadBindings().then(() => {
        const { Lockfile } = require(${JSON.stringify(lockfile)});
        const lock = Lockfile.tryAcquire(${JSON.stringify(lockPath)}, false);
        lock?.unlockSync();
        process.exitCode = lock ? 3 : 4;
      });`);
    try {
      await assert.rejects(main({ ...options, spawnChild: children.spawnChild }), held ? /\[ui\] exited \(4\)/ : /\[ui\] exited \(3\)/);
      if (held) assert.equal(readFileSync(lockPath, "utf8"), "active owner");
      await assertStopped(children.children);
    } finally { lock?.unlockSync(); }
  });
}

function desktopFixtures(options, assetDir, desktopCode = "process.exit(0)") {
  const calls = [];
  const children = [];
  const scripts = [`${readyCode(options.env)} setInterval(() => {}, 1000);`, desktopCode];
  return {
    calls, children,
    spawnChild(command, args, childOptions) {
      const index = calls.length;
      calls.push({ command, args, options: childOptions });
      assert.equal(command, index === 0 ? process.execPath : "fixture-electron");
      const child = spawn(process.execPath, ["--eval", scripts[index]], childOptions);
      children.push(child);
      return child;
    },
  };
}

function desktopAssetDir(t) {
  const directory = mkdtempSync(join(tmpdir(), "weclio-desktop-ui-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>fixture</title>");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("desktop loads prebuilt static assets and never starts a UI server", async (t) => {
  const options = await fixture(t);
  const assetDir = desktopAssetDir(t);
  const guiEnvFile = join(options.cwd, "gui-env");
  const children = desktopFixtures(options, assetDir, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(guiEnvFile)}, JSON.stringify(process.env)); process.exit(0);`);
  const output = [];
  await main({ ...options, env: { ...options.env, WECLIO_DESKTOP_UI_DIR: assetDir }, spawnChild: children.spawnChild,
    desktop: { executable: "fixture-electron", args: ["main.mjs", "--fixture"] }, onOutput: (chunk) => output.push(chunk) });
  assert.equal(children.calls.length, 2, "only Service and Electron are spawned");
  assert.deepEqual(children.calls[1].args, ["main.mjs", "--fixture"]);
  for (const [index, call] of children.calls.entries()) {
    assert.equal(call.options.windowsHide, index !== 1, "the GUI is visible, Node children are hidden");
    assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(call.options.detached, process.platform !== "win32");
  }
  const serviceUrl = `http://127.0.0.1:${options.env.WECLIO_DEV_SERVICE_PORT}`;
  assert.equal(children.calls[0].options.env.WECLIO_AGENT_ALLOWED_ORIGINS, "weclio://app");
  const guiEnv = JSON.parse(readFileSync(guiEnvFile, "utf8"));
  assert.equal(guiEnv.WECLIO_DESKTOP_AGENT_URL, serviceUrl);
  assert.equal(guiEnv.WECLIO_DESKTOP_AGENT_TOKEN_FILE, options.env.WECLIO_AGENT_TOKEN_FILE);
  assert.equal(guiEnv.WECLIO_DESKTOP_UI_DIR, assetDir);
  assert.equal(guiEnv.WECLIO_DESKTOP_URL, undefined, "no HTTP UI origin is passed to the GUI");
  assert.equal(guiEnv.NEXT_PUBLIC_WECLIO_AGENT_TOKEN, undefined, "the raw token never reaches the renderer environment");
  assert.equal(guiEnv.NEXT_PUBLIC_WECLIO_API_URL, undefined);
  assert.ok(output.some((chunk) => chunk.includes("WECLIO_AGENT_")));
  await assertStopped(children.children);
});

test("desktop refuses to start without prebuilt static assets", async (t) => {
  const options = await fixture(t);
  const assetDir = join(options.cwd, "missing-assets");
  const env = { ...options.env, WECLIO_DESKTOP_UI_DIR: assetDir };
  await assert.rejects(main({ ...options, env, spawnChild() { assert.fail("must not spawn"); },
    desktop: { executable: "fixture-electron" } }), /Desktop UI not found.*build:desktop-ui/);
});

test("desktop does not reserve or require the Web UI port", async (t) => {
  const options = await fixture(t);
  const assetDir = desktopAssetDir(t);
  // Web UI 端口被无关进程占用也不影响 Desktop 启动。
  const occupied = await listen();
  t.after(() => occupied.close());
  const env = { ...options.env, WECLIO_DEV_UI_PORT: String(occupied.address().port), WECLIO_DESKTOP_UI_DIR: assetDir };
  const children = desktopFixtures(options, assetDir);
  await main({ ...options, env, spawnChild: children.spawnChild, desktop: { executable: "fixture-electron" } });
  assert.equal(children.calls.length, 2);
  await assertStopped(children.children);
});

test("desktop never launches when the Service fails readiness", async (t) => {
  const options = await fixture(t);
  const assetDir = desktopAssetDir(t);
  const env = { ...options.env, WECLIO_DESKTOP_UI_DIR: assetDir };
  const failing = spawnFixtures("process.exit(3)", "process.exit(0)");
  await assert.rejects(main({ ...options, env, spawnChild: failing.spawnChild, timeoutMs: 500,
    desktop: { executable: "fixture-electron" } }), /\[service\] exited \(3\)/);
  assert.equal(failing.children.length, 1);
  await assertStopped(failing.children);
});

for (const spawnError of [false, true]) {
  test(`desktop ${spawnError ? "spawn error" : "nonzero exit"} stops the owned Service`, async (t) => {
    const options = await fixture(t);
    const assetDir = desktopAssetDir(t);
    const env = { ...options.env, WECLIO_DESKTOP_UI_DIR: assetDir };
    const children = desktopFixtures(options, assetDir, "process.exit(7)");
    const spawnChild = (command, args, opts) => command === "fixture-electron" && spawnError
      ? spawn(join(options.cwd, "missing-electron"), args, opts)
      : children.spawnChild(command, args, opts);
    await assert.rejects(main({ ...options, env, spawnChild, desktop: { executable: "fixture-electron" } }), /\[desktop\].*(ENOENT|exited \(7\))/);
    await assertStopped(children.children);
  });
}

test("desktop asset directory may be an absolute override", async (t) => {
  const options = await fixture(t);
  const assetDir = desktopAssetDir(t);
  const children = desktopFixtures(options, assetDir);
  await main({ ...options, env: { ...options.env, WECLIO_DESKTOP_UI_DIR: assetDir }, spawnChild: children.spawnChild,
    desktop: { executable: "fixture-electron" } });
  assert.equal(children.calls[1].options.env.WECLIO_DESKTOP_UI_DIR, assetDir);
  await assertStopped(children.children);
});

for (const forceExit of [false, true]) {
  test(`supervisor ${forceExit ? "process.exit" : "SIGINT"} stops its own children and descendants, not unrelated Node`, async (t) => {
    const options = await fixture(t);
    const assetDir = desktopAssetDir(t);
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
      const scripts = ${JSON.stringify([serviceCode, "setInterval(() => {}, 1000)"])};
      const pids = [];
      await main({ cwd: ${JSON.stringify(options.cwd)}, env: { ...process.env, WECLIO_DESKTOP_UI_DIR: ${JSON.stringify(assetDir)} },
        desktop: { executable: 'fixture-electron' },
        spawnChild(command, args, opts) {
          const child = spawn(process.execPath, ['--eval', scripts[pids.length]], opts);
          pids.push(child.pid);
          writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify(pids));
          if (pids.length === 2) setTimeout(() => ${forceExit ? "process.exit(0)" : "process.emit('SIGINT')"}, 150);
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
    assert.equal(pids.length, 2);
    pids.push(Number(readFileSync(descendantFile, "utf8")));
    await assertStopped(pids.map((pid) => ({ pid })));
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  });
}
