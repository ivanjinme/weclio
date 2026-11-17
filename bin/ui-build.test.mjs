import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { assertUiOnlyBuild } = require("./ui-build.js");
const binDir = path.dirname(fileURLToPath(import.meta.url));
const pages = {
  "/page": "app/page.js",
  "/_not-found/page": "app/_not-found/page.js",
  "/_global-error/page": "app/_global-error/page.js",
};

function fixture(t, manifest, hook) {
  const root = mkdtempSync(path.join(tmpdir(), "weclio-ui-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nextDir = path.join(root, ".next");
  const serverDir = path.join(nextDir, "server");
  mkdirSync(serverDir, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(path.join(serverDir, "app-paths-manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  if (hook) writeFileSync(path.join(serverDir, hook), "throw new Error('must not load old backend');");
  return { root, nextDir };
}

const rejected = [
  ["API route", { ...pages, "/api/agent/new/route": "app/api/agent/new/route.js" }],
  ["non-API route handler", { ...pages, "/events/route": "app/events/route.js" }],
  ["API page", { ...pages, "/api/page": "app/api/page.js" }],
  ["unexpected page", { ...pages, "/other/page": "app/other/page.js" }],
  ["backend output disguised as page", { ...pages, "/page": "app/api/agent/route.js" }],
  ["backend output disguised as favicon", { ...pages, "/favicon.ico/route": "app/api/agent/route.js" }],
  ["other metadata route", { ...pages, "/icon/route": "app/icon/route.js" }],
  ["invalid output", { ...pages, "/page": null }],
  ["missing manifest", undefined],
  ["malformed JSON", "{"],
  ["null manifest", "null"],
  ["array manifest", "[]"],
  ["empty manifest", {}],
  ["instrumentation hook", pages, "instrumentation.js"],
  ["node instrumentation hook", pages, "instrumentation-node.js"],
];

function runCli(root) {
  const fixtureBin = path.join(root, "bin");
  mkdirSync(fixtureBin);
  for (const filename of ["pi-web.js", "pi-web-options.js", "node-version.js", "ui-build.js"]) {
    copyFileSync(path.join(binDir, filename), path.join(fixtureBin, filename));
  }
  const marker = path.join(root, "spawned.json");
  const preload = path.join(root, "spawn-stub.cjs");
  writeFileSync(preload, `
    const { EventEmitter } = require('node:events');
    require('node:child_process').spawn = (command, args, options) => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({command, args, options}));
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      process.nextTick(() => child.emit('exit', 0));
      return child;
    };
  `);
  const result = spawnSync(process.execPath, ["--require", preload, path.join(fixtureBin, "pi-web.js"), "--no-open"], {
    encoding: "utf8",
    env: { ...process.env, PI_WEB_HOSTNAME: "127.0.0.1", NODE_ENV: "development", WECLIO_DEV_UI_DIST_DIR: "stale-dev-output" },
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { result, marker };
}

for (const [label, manifest, hook] of rejected) {
  test(`guard and CLI reject ${label} without spawning`, (t) => {
    const { root, nextDir } = fixture(t, manifest, hook);
    assert.throws(() => assertUiOnlyBuild(nextDir), /old backend artifacts.*Rebuild the UI/);
    const { result, marker } = runCli(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /old backend artifacts.*Rebuild the UI/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(nextDir), true);
  });
}

for (const manifest of [pages, { "/page": "app/page.js" }, { ...pages, "/favicon.ico/route": "app/favicon.ico/route.js" }]) {
  test(`current UI-only manifest (${Object.keys(manifest).length} entries) starts CLI`, (t) => {
    const { root, nextDir } = fixture(t, manifest);
    assert.doesNotThrow(() => assertUiOnlyBuild(nextDir));
    const { result, marker } = runCli(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), true);
    const spawned = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(spawned.options.env.NODE_ENV, "production");
    assert.equal(spawned.options.env.WECLIO_DEV_UI_DIST_DIR, undefined);
  });
}

test("missing build directory fails closed", (t) => {
  const { root } = fixture(t, pages);
  assert.throws(() => assertUiOnlyBuild(path.join(root, "missing")), /missing or malformed/);
});
